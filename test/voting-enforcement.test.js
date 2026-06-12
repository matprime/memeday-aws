const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// Load .env so the DynamoDB client gets table name, region, and credentials.
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

// lib/db.ts is written for the Next.js runtime; these hooks let Node's native
// type stripping load it directly: stub "next/cache" and resolve the
// extensionless relative imports TypeScript allows but ESM does not.
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

test("voting: server enforces one vote per user per meme", async (t) => {
  if (!process.env.DYNAMODB_TABLE_NAME || !process.env.AWS_ACCESS_KEY_ID) {
    t.skip("Missing DYNAMODB_TABLE_NAME or AWS credentials");
    return;
  }

  const { createMeme, voteMeme, getMemeById } = await import("../lib/db.ts");
  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { DeleteCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

  const userId = `test_user_${Date.now()}`;

  const meme = await createMeme({
    creatorId: userId,
    s3Key: "test/voting-enforcement.png",
    caption: "test meme",
    isNFT: false,
  });
  assert.ok(meme?.id, "expected created meme id");

  try {
    const first = await voteMeme(meme.id, userId);
    assert.strictEqual(first, true, "first vote should succeed");

    const second = await voteMeme(meme.id, userId);
    assert.strictEqual(second, false, "second vote should be rejected");

    const memeAfter = await getMemeById(meme.id);
    assert.strictEqual(memeAfter.likeCount, 1, "likeCount should remain 1");
    assert.strictEqual(memeAfter.score, 1, "score should remain 1");

    const { Items: likes } = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :like)",
        ExpressionAttributeValues: { ":pk": `MEME#${meme.id}`, ":like": "LIKE#" },
      })
    );
    assert.strictEqual(likes.length, 1, "exactly one LIKE item should exist");
  } finally {
    await dynamo.send(
      new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `LIKE#${userId}` } })
    );
    await dynamo.send(
      new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } })
    );
  }
});
