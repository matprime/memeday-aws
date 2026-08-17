const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { randomUUID } = require("node:crypto");
const { hasAwsCredentials } = require("./helpers/aws-credentials");

// .env.local overrides .env, same precedence Next.js uses — dev credentials/table names live there.
for (const envFile of [".env.local", ".env"]) {
  const envPath = path.join(__dirname, "..", envFile);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
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

function skipIfNoCredentials(t) {
  if (!process.env.DYNAMODB_TABLE_NAME || !hasAwsCredentials()) {
    t.skip("Missing DYNAMODB_TABLE_NAME or AWS credentials");
    return true;
  }
  return false;
}

// Mirrors what the actual Rekognition DetectModerationLabels response shape
// looks like (ModerationLabel[]) — used to feed isBlocked()/logModerationResult()
// without ever calling live Rekognition, per the project's no-live-AWS-calls-in-tests rule.
function label(name, confidence) {
  return { Name: name, Confidence: confidence };
}

// --- Pure block-decision logic: no AWS calls, no credentials needed ---

test("isBlocked: label at threshold confidence in block set triggers block (Explicit Nudity)", async () => {
  const { isBlocked } = await import("../lambdas/moderation-handler/index.ts");
  assert.strictEqual(isBlocked([label("Explicit Nudity", 80)]), true);
  assert.strictEqual(isBlocked([label("Exposed Female Nipple", 91.2)]), true);
});

test("isBlocked: label above threshold in block set triggers block (Graphic Violence / Weapon Violence)", async () => {
  const { isBlocked } = await import("../lambdas/moderation-handler/index.ts");
  assert.strictEqual(isBlocked([label("Graphic Violence", 85)]), true);
  assert.strictEqual(isBlocked([label("Weapon Violence", 99.9)]), true);
});

test("isBlocked: label in block set triggers block (Hate Symbols)", async () => {
  const { isBlocked } = await import("../lambdas/moderation-handler/index.ts");
  assert.strictEqual(isBlocked([label("Hate Symbols", 80.01)]), true);
  assert.strictEqual(isBlocked([label("Nazi Party", 100)]), true);
});

test("isBlocked: label just under 80% confidence does not block", async () => {
  const { isBlocked } = await import("../lambdas/moderation-handler/index.ts");
  assert.strictEqual(isBlocked([label("Explicit Nudity", 79.99)]), false);
  assert.strictEqual(isBlocked([label("Graphic Violence", 79)]), false);
});

test("isBlocked: labels outside the block set never block regardless of confidence", async () => {
  const { isBlocked } = await import("../lambdas/moderation-handler/index.ts");
  assert.strictEqual(isBlocked([label("Suggestive", 100)]), false);
  assert.strictEqual(isBlocked([label("Alcohol", 100)]), false);
  assert.strictEqual(isBlocked([label("Non-Explicit Nudity of Intimate parts and Kissing", 99)]), false);
  assert.strictEqual(isBlocked([label("Violence", 100)]), false); // bare top-level, not "Graphic Violence"
});

test("isBlocked: mixed label array only blocks when a qualifying label is present", async () => {
  const { isBlocked } = await import("../lambdas/moderation-handler/index.ts");
  assert.strictEqual(
    isBlocked([label("Suggestive", 95), label("Alcohol", 90), label("Explicit Nudity", 60)]),
    false,
    "block-set label under threshold + non-block-set labels above threshold should not block"
  );
  assert.strictEqual(
    isBlocked([label("Suggestive", 95), label("Weapons", 80)]),
    true,
    "one qualifying label is enough even alongside non-blocking labels"
  );
});

test("logModerationResult: logs all labels (not just blocking ones) and the action taken", async () => {
  const { logModerationResult } = await import("../lambdas/moderation-handler/index.ts");
  const originalLog = console.log;
  const lines = [];
  console.log = (msg) => lines.push(msg);
  try {
    logModerationResult({
      key: "uploads/user1/abc.png",
      pendingId: "abc",
      labels: [label("Suggestive", 91), label("Explicit Nudity", 88)],
      action: "blocked",
    });
  } finally {
    console.log = originalLog;
  }
  assert.strictEqual(lines.length, 1, "logs exactly once");
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.key, "uploads/user1/abc.png");
  assert.strictEqual(parsed.pendingId, "abc");
  assert.strictEqual(parsed.action, "blocked");
  assert.strictEqual(parsed.labels.length, 2, "logs every returned label, not just the blocking one");
  assert.deepStrictEqual(parsed.labels[0], { name: "Suggestive", confidence: 91 });
  assert.deepStrictEqual(parsed.labels[1], { name: "Explicit Nudity", confidence: 88 });
});

test("logModerationResult: clean result logs action=published", async () => {
  const { logModerationResult } = await import("../lambdas/moderation-handler/index.ts");
  const originalLog = console.log;
  const lines = [];
  console.log = (msg) => lines.push(msg);
  try {
    logModerationResult({
      key: "uploads/user1/def.png",
      pendingId: "def",
      labels: [label("Suggestive", 60)],
      action: "published",
    });
  } finally {
    console.log = originalLog;
  }
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.action, "published");
  assert.strictEqual(parsed.labels.length, 1);
});

// --- handler(): new {bucket, key} invoke payload, no HeadObjectCommand/validated
// guard (removed — S3Handler now invokes this Lambda directly, exactly once,
// only after its own validation succeeds). Rekognition is mocked by swapping
// .send on the exported client instance; no live Rekognition calls.

test("handler: processes a {bucket, key} payload directly, publishes on a clean result (no S3 call needed)", async () => {
  const { handler, rekognition } = await import("../lambdas/moderation-handler/index.ts");

  const originalSend = rekognition.send;
  const originalLog = console.log;
  const lines = [];
  console.log = (msg) => lines.push(msg);
  rekognition.send = async () => ({ ModerationLabels: [{ Name: "Suggestive", Confidence: 91 }] });

  try {
    await handler({ bucket: "test-bucket", key: "uploads/user1/clean-xyz.png" });
  } finally {
    rekognition.send = originalSend;
    console.log = originalLog;
  }

  assert.strictEqual(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.action, "published");
  assert.strictEqual(parsed.pendingId, "clean-xyz");
});

test("handler: blocked result from a {bucket, key} payload rejects the PENDING# record", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { handler, rekognition } = await import("../lambdas/moderation-handler/index.ts");
  const { createPendingUpload, getPendingUpload } = await import("../lib/db.ts");
  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const id = randomUUID();
  const creatorId = `test-mod-handler-${Date.now()}`;
  const key = `uploads/${creatorId}/${id}.png`;

  await createPendingUpload({
    id,
    creatorId,
    s3Key: key,
    caption: "moderation handler payload test",
  });

  const originalSend = rekognition.send;
  rekognition.send = async () => ({ ModerationLabels: [{ Name: "Explicit Nudity", Confidence: 95 }] });

  try {
    await handler({ bucket: "test-bucket", key });

    const pending = await getPendingUpload(id);
    assert.strictEqual(pending.status, "rejected");
  } finally {
    rekognition.send = originalSend;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PENDING#${id}`, SK: `PENDING#${id}` } }));
  }
});

// --- applyBlockDecision: live DynamoDB (dev table), Rekognition never called ---
// (follows the same live-dev-table pattern as test/pending-upload.test.js and
// test/stream-handler.test.js — only the Rekognition network call is mocked,
// by never making it: these tests hand applyBlockDecision a pendingId and
// skip straight to the DB write it performs after a block decision.)

test("moderation block: no prior MEME# item — PENDING# is rejected with a generic reason, no meme is ever created", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { applyBlockDecision } = await import("../lambdas/moderation-handler/index.ts");
  const { createPendingUpload, getPendingUpload, getMemeById } = await import("../lib/db.ts");
  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const id = randomUUID();
  const creatorId = `test-mod-user-${Date.now()}`;

  await createPendingUpload({
    id,
    creatorId,
    s3Key: `uploads/${creatorId}/${id}.png`,
    caption: "moderation block test",
  });

  try {
    const outcome = await applyBlockDecision(id);
    assert.strictEqual(outcome, "blocked");

    const pending = await getPendingUpload(id);
    assert.strictEqual(pending.status, "rejected");
    assert.ok(pending.reason, "reason is set");
    assert.doesNotMatch(
      pending.reason,
      /Explicit|Nudity|Violence|Hate|Confidence|%/i,
      "reason must not leak the specific Rekognition label or confidence score"
    );

    const meme = await getMemeById(id);
    assert.strictEqual(meme, null, "no MEME# item was ever created for a blocked upload");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PENDING#${id}`, SK: `PENDING#${id}` } }));
  }
});

test("moderation block: prior MEME# item already exists — it is set to pending_review, hidden from direct URL", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { applyBlockDecision } = await import("../lambdas/moderation-handler/index.ts");
  const { createMeme, getMemeById } = await import("../lib/db.ts");
  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const id = randomUUID();
  const creatorId = `test-mod-user-${Date.now()}`;

  // Simulates the race: client already finalized (POST /api/memes) before
  // the async moderation result came back.
  await createMeme({
    id,
    creatorId,
    s3Key: `uploads/${creatorId}/${id}.png`,
    caption: "moderation block race test",
    isNFT: false,
  });

  try {
    const outcome = await applyBlockDecision(id);
    assert.strictEqual(outcome, "pending_review");

    const raw = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${id}`, SK: `MEME#${id}` } })
    );
    assert.strictEqual(raw.Item.status, "pending_review", "meme item is flipped to pending_review, not deleted");

    const viaDirectUrl = await getMemeById(id);
    assert.strictEqual(viaDirectUrl, null, "pending_review meme is not reachable by direct URL lookup");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${id}`, SK: `MEME#${id}` } }));
  }
});

test("moderation block: flagged item is removed from FEED#GLOBAL (and GSI3) once already published", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { applyBlockDecision } = await import("../lambdas/moderation-handler/index.ts");
  const { createMeme } = await import("../lib/db.ts");
  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { handler: streamHandler } = await import("../lambdas/stream-handler/index.ts");
  const { GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const id = randomUUID();
  const creatorId = `test-mod-feed-${Date.now()}`;
  const feedSK = `${"0".repeat(15)}#${id}`;

  await createMeme({
    id,
    creatorId,
    s3Key: `uploads/${creatorId}/${id}.png`,
    caption: "moderation feed-removal test",
    isNFT: false,
  });

  function memeStreamImage(status) {
    return {
      PK: { S: `MEME#${id}` },
      SK: { S: `MEME#${id}` },
      memeId: { S: id },
      creatorId: { S: creatorId },
      ownerId: { S: creatorId },
      s3Key: { S: `uploads/${creatorId}/${id}.png` },
      caption: { S: "moderation feed-removal test" },
      score: { N: "0" },
      likeCount: { N: "0" },
      commentCount: { N: "0" },
      status: { S: status },
      createdAt: { S: "2024-01-01T00:00:00.000Z" },
    };
  }

  try {
    // Simulate the stream-handler INSERT that would have fired when
    // createMeme wrote the item (status: active at that point).
    await streamHandler(
      { Records: [{ eventName: "INSERT", dynamodb: { Keys: { PK: { S: `MEME#${id}` }, SK: { S: `MEME#${id}` } }, NewImage: memeStreamImage("active") } }] },
      {},
      () => {}
    );

    const feedBefore = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
    assert.ok(feedBefore.Item, "sanity check: feed item exists before moderation blocks it");

    const outcome = await applyBlockDecision(id);
    assert.strictEqual(outcome, "pending_review");

    // Simulate the stream-handler MODIFY that fires when moderation flips status.
    await streamHandler(
      {
        Records: [
          {
            eventName: "MODIFY",
            dynamodb: {
              Keys: { PK: { S: `MEME#${id}` }, SK: { S: `MEME#${id}` } },
              NewImage: memeStreamImage("pending_review"),
              OldImage: memeStreamImage("active"),
            },
          },
        ],
      },
      {},
      () => {}
    );

    const feedAfter = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
    assert.strictEqual(feedAfter.Item, undefined, "flagged item must not appear in a FEED#GLOBAL/GSI3 query result");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${id}`, SK: `MEME#${id}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` } }));
  }
});

test("moderation clean path: finalize proceeds through the normal publish flow unchanged", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { isBlocked } = await import("../lambdas/moderation-handler/index.ts");
  const { createPendingUpload, getPendingUpload, finalizeMeme, getMemeById } = await import("../lib/db.ts");
  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const id = randomUUID();
  const creatorId = `test-mod-clean-${Date.now()}`;

  // Clean Rekognition response: nothing in the block set.
  const cleanLabels = [label("Suggestive", 91), label("Alcohol", 88)];
  assert.strictEqual(isBlocked(cleanLabels), false, "clean labels never trigger a block");

  await createPendingUpload({
    id,
    creatorId,
    s3Key: `uploads/${creatorId}/${id}.png`,
    caption: "moderation clean path test",
  });

  try {
    // No applyBlockDecision call — clean path is a pure no-op on the DB
    // (see lambdas/moderation-handler/index.ts handler: only the blocked
    // branch touches PENDING#/MEME# records).
    const pending = await getPendingUpload(id);
    const meme = await finalizeMeme(pending, { isNFT: false });
    assert.strictEqual(meme.status, "active", "publish flow is unaffected by a clean moderation result");

    const stored = await getMemeById(id);
    assert.ok(stored, "meme is publicly retrievable");
  } finally {
    const { GetCommand } = require("@aws-sdk/lib-dynamodb");
    const feedSK = `${"0".repeat(15)}#${id}`;
    for (let i = 0; i < 10; i++) {
      const { Item } = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
      if (Item) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${id}`, SK: `MEME#${id}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` } }));
  }
});
