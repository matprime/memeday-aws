const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { randomUUID } = require("node:crypto");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/cache") {
      const stub = path.join(__dirname, "helpers", "next-cache-stub.mjs");
      return { url: pathToFileURL(stub).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

// Mirrors what the S3Handler Lambda does on successful/failed validation
// (lambdas/s3-handler/index.ts), without needing a real S3 upload.
async function markActive(dynamo, TABLE, id) {
  const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `PENDING#${id}`, SK: `PENDING#${id}` },
      UpdateExpression: "SET #status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":active": "active" },
    })
  );
}

async function markRejected(dynamo, TABLE, id, reason) {
  const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `PENDING#${id}`, SK: `PENDING#${id}` },
      UpdateExpression: "SET #status = :rejected, reason = :reason",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":rejected": "rejected", ":reason": reason },
    })
  );
}

test("pending upload: valid path creates a real, feed-eligible meme", async (t) => {
  if (!process.env.DYNAMODB_TABLE_NAME || !process.env.AWS_ACCESS_KEY_ID) {
    t.skip("Missing DYNAMODB_TABLE_NAME or AWS credentials");
    return;
  }

  const { createPendingUpload, getPendingUpload, finalizeMeme, getMemeById } = await import("../lib/db.ts");
  const { dynamo, TABLE } = await import("../lib/dynamo.ts");

  const id = randomUUID();
  const creatorId = `test-user-${Date.now()}`;

  await createPendingUpload({
    id,
    creatorId,
    s3Key: `uploads/${creatorId}/${id}.png`,
    caption: "pending upload test",
  });

  let pending = await getPendingUpload(id);
  assert.strictEqual(pending.status, "pending_upload", "starts as pending_upload");

  // Simulate the S3Handler Lambda validating the upload.
  await markActive(dynamo, TABLE, id);
  pending = await getPendingUpload(id);
  assert.strictEqual(pending.status, "active", "Lambda flips status to active");

  const meme = await finalizeMeme(pending, { isNFT: false });
  assert.strictEqual(meme.status, "active", "finalized meme is active");
  assert.strictEqual(meme.id, id, "meme id reuses the pending id (embedded in the S3 key)");

  const stored = await getMemeById(id);
  assert.ok(stored, "meme is retrievable — this is what makes it feed-eligible via DynamoDB Streams");

  const afterFinalize = await getPendingUpload(id);
  assert.strictEqual(afterFinalize, null, "pending record is deleted once finalized");
});

test("pending upload: rejected path never produces a meme", async (t) => {
  if (!process.env.DYNAMODB_TABLE_NAME || !process.env.AWS_ACCESS_KEY_ID) {
    t.skip("Missing DYNAMODB_TABLE_NAME or AWS credentials");
    return;
  }

  const { createPendingUpload, getPendingUpload, getMemeById } = await import("../lib/db.ts");
  const { dynamo, TABLE } = await import("../lib/dynamo.ts");

  const id = randomUUID();
  const creatorId = `test-user-${Date.now()}`;

  await createPendingUpload({
    id,
    creatorId,
    s3Key: `uploads/${creatorId}/${id}.png`,
    caption: "rejected upload test",
  });

  // Simulate the S3Handler Lambda rejecting the upload.
  await markRejected(dynamo, TABLE, id, "file too large: 6291456 bytes (max 5242880)");

  const pending = await getPendingUpload(id);
  assert.strictEqual(pending.status, "rejected");
  assert.match(pending.reason, /too large/);

  const meme = await getMemeById(id);
  assert.strictEqual(meme, null, "no MEME# item was ever created — never reaches the feed");

  // cleanup
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  await dynamo.send(
    new DeleteCommand({ TableName: TABLE, Key: { PK: `PENDING#${id}`, SK: `PENDING#${id}` } })
  );
});
