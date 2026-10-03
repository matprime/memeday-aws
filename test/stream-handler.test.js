const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
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

// Builds a DynamoDB Stream image (marshalled attribute value format).
function memeImage(memeId, creatorId, score) {
  return {
    PK: { S: `MEME#${memeId}` },
    SK: { S: `MEME#${memeId}` },
    memeId: { S: memeId },
    creatorId: { S: creatorId },
    ownerId: { S: creatorId },
    s3Key: { S: "test/stream-handler.png" },
    caption: { S: "stream handler test meme" },
    score: { N: String(score) },
    likeCount: { N: String(score) },
    commentCount: { N: "0" },
    status: { S: "active" },
    createdAt: { S: "2024-01-01T00:00:00.000Z" },
  };
}

function streamEvent(eventName, newImage, oldImage) {
  const keySource = newImage ?? oldImage;
  const record = {
    eventName,
    dynamodb: {
      Keys: { PK: keySource.PK, SK: keySource.SK },
    },
  };
  if (newImage) record.dynamodb.NewImage = newImage;
  if (oldImage) record.dynamodb.OldImage = oldImage;
  return { Records: [record] };
}

function padScore(n) {
  return Math.max(0, n).toString().padStart(15, "0");
}

// Same shape as memeImage but with a settable status, for KAN-43 takedown
// transitions (mirrors test/moderation-handler.test.js's memeStreamImage).
function memeImageWithStatus(memeId, creatorId, status, extra = {}) {
  return {
    PK: { S: `MEME#${memeId}` },
    SK: { S: `MEME#${memeId}` },
    memeId: { S: memeId },
    creatorId: { S: creatorId },
    ownerId: { S: creatorId },
    s3Key: { S: `uploads/${creatorId}/${memeId}.png` },
    caption: { S: "takedown test meme" },
    score: { N: "0" },
    likeCount: { N: "0" },
    commentCount: { N: "0" },
    status: { S: status },
    createdAt: { S: "2024-01-01T00:00:00.000Z" },
    ...(extra.removedBy ? { removedBy: { S: extra.removedBy } } : {}),
  };
}

// A REPORT# item's stream image (PK=MEME#<id>, SK=REPORT#<hash>) — mirrors
// what lib/db.ts's createReport actually writes.
function reportImage(memeId, identityHash, reason, createdAt) {
  return {
    PK: { S: `MEME#${memeId}` },
    SK: { S: `REPORT#${identityHash}` },
    reason: { S: reason },
    createdAt: { S: createdAt },
  };
}

// KAN-67: StreamHandler only writes leaderboard and points rows for a creator
// whose USER# item exists, so a test that expects those rows seeds one first.
function userKey(userId) {
  return { PK: `USER#${userId}`, SK: `USER#${userId}` };
}

async function seedUser(dynamo, TABLE, userId) {
  const { PutCommand } = require("@aws-sdk/lib-dynamodb");
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...userKey(userId), userId, authMethods: [], credScore: 0, createdAt: new Date().toISOString() },
    })
  );
}

// The rows a clean MEME# INSERT's UPLOAD award writes for a creator who has a
// USER# item: the ledger row plus the day/week/all-time totals. Bucket keys
// come from lib/points-config.ts, the same functions the handler itself uses.
async function uploadAwardKeys(creatorId, memeId, createdAt) {
  const { utcDateKey, isoWeekKey } = await import("../lib/points-config.ts");
  const d = new Date(createdAt);
  return {
    award: { PK: `POINTS#${creatorId}`, SK: `AWARD#UPLOAD#${memeId}` },
    totals: [
      { PK: `LB#DAY#${utcDateKey(d)}`, SK: `USER#${creatorId}` },
      { PK: `LB#WEEK#${isoWeekKey(d)}`, SK: `USER#${creatorId}` },
      { PK: "LB#ALLTIME", SK: `USER#${creatorId}` },
    ],
  };
}

// createdAt carried by every memeImage() / memeImageWithStatus() below.
const IMAGE_CREATED_AT = "2024-01-01T00:00:00.000Z";

async function deleteKeys(dynamo, TABLE, keys) {
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  for (const key of keys) {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: key }));
  }
}

function skipIfNoCredentials(t) {
  if (!process.env.DYNAMODB_TABLE_NAME || !hasAwsCredentials()) {
    t.skip("Missing DYNAMODB_TABLE_NAME or AWS credentials");
    return true;
  }
  return false;
}

test("stream-handler: INSERT writes feed item and increments leaderboard", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_insert_${Date.now()}`;
  const creatorId = `test_sh_creator_${Date.now()}`;
  const feedSK = `${padScore(0)}#${memeId}`;
  const uploadAward = await uploadAwardKeys(creatorId, memeId, IMAGE_CREATED_AT);

  await seedUser(dynamo, TABLE, creatorId);

  try {
    await handler(streamEvent("INSERT", memeImage(memeId, creatorId, 0)), {}, () => {});

    const feedItem = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } })
    );
    assert.ok(feedItem.Item, "feed item should exist after INSERT");
    assert.strictEqual(feedItem.Item.memeId, memeId, "feed item memeId should match");
    assert.strictEqual(feedItem.Item.score, 0, "feed item score should be 0");
    assert.strictEqual(feedItem.Item.creatorId, creatorId, "feed item creatorId should match");

    const lbItem = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` } })
    );
    assert.ok(lbItem.Item, "leaderboard item should exist after INSERT");
    assert.strictEqual(lbItem.Item.memeCount, 1, "memeCount should be 1 after first meme");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` } }));
    await deleteKeys(dynamo, TABLE, [userKey(creatorId), uploadAward.award, ...uploadAward.totals]);
  }
});

test("stream-handler: MODIFY with score change moves feed item to new SK", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_modify_${Date.now()}`;
  const creatorId = `test_sh_creator_mod_${Date.now()}`;
  const oldSK = `${padScore(0)}#${memeId}`;
  const newSK = `${padScore(1)}#${memeId}`;

  // Seed the feed item as it would exist after the INSERT event.
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: "FEED#GLOBAL",
        SK: oldSK,
        GSI3PK: "FEED#GLOBAL",
        GSI3SK: "2024-01-01T00:00:00.000Z",
        memeId,
        creatorId,
        s3Key: "test/stream-handler.png",
        caption: "stream handler test meme",
        score: 0,
      },
    })
  );

  try {
    await handler(
      streamEvent("MODIFY", memeImage(memeId, creatorId, 1), memeImage(memeId, creatorId, 0)),
      {},
      () => {}
    );

    const oldItem = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: oldSK } })
    );
    assert.strictEqual(oldItem.Item, undefined, "old score SK should be deleted after vote");

    const newItem = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: newSK } })
    );
    assert.ok(newItem.Item, "new score SK should exist after vote");
    assert.strictEqual(newItem.Item.score, 1, "new feed item score should be 1");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: oldSK } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: newSK } }));
  }
});

test("stream-handler: MODIFY with no score change does not touch feed", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_noop_${Date.now()}`;
  const creatorId = `test_sh_creator_noop_${Date.now()}`;
  const feedSK = `${padScore(1)}#${memeId}`;

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: "FEED#GLOBAL", SK: feedSK, memeId, creatorId, score: 1 },
    })
  );

  try {
    // MODIFY where only caption changed, score stays at 1
    const modifiedImage = { ...memeImage(memeId, creatorId, 1), caption: { S: "updated caption" } };
    await handler(
      streamEvent("MODIFY", modifiedImage, memeImage(memeId, creatorId, 1)),
      {},
      () => {}
    );

    const feedItem = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } })
    );
    assert.ok(feedItem.Item, "feed item should still exist when score unchanged");
    assert.strictEqual(feedItem.Item.score, 1, "score should still be 1");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
  }
});

test("stream-handler: REMOVE deletes feed item and decrements leaderboard", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_remove_${Date.now()}`;
  const creatorId = `test_sh_creator_rem_${Date.now()}`;
  const feedSK = `${padScore(0)}#${memeId}`;

  // Seed state as if INSERT already ran and memeCount is 2.
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: "FEED#GLOBAL", SK: feedSK, memeId, creatorId, score: 0 },
    })
  );
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}`, creatorId, memeCount: 2 },
    })
  );

  try {
    await handler(streamEvent("REMOVE", null, memeImage(memeId, creatorId, 0)), {}, () => {});

    const feedItem = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } })
    );
    assert.strictEqual(feedItem.Item, undefined, "feed item should be deleted after REMOVE");

    const lbItem = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` } })
    );
    assert.ok(lbItem.Item, "leaderboard item should still exist");
    assert.strictEqual(lbItem.Item.memeCount, 1, "memeCount should decrement from 2 to 1");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` } }));
  }
});

test("stream-handler: non-meme records are ignored", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { handler } = await import("../lambdas/stream-handler/index.ts");

  // LIKE item (PK=MEME#, SK=LIKE#) — should be silently skipped
  const likeRecord = {
    eventName: "INSERT",
    dynamodb: {
      Keys: { PK: { S: "MEME#someid" }, SK: { S: "LIKE#userid" } },
      NewImage: { PK: { S: "MEME#someid" }, SK: { S: "LIKE#userid" }, createdAt: { S: "2024-01-01T00:00:00.000Z" } },
    },
  };

  // Should complete without throwing
  await assert.doesNotReject(
    handler({ Records: [likeRecord] }, {}, () => {}),
    "non-meme records should not throw"
  );
});

// ── KAN-43 takedown: MODIFY status -> "removed" ─────────────────────────────

test("stream-handler: active -> removed deletes the S3 object, invalidates CloudFront, drops the feed item, decrements the leaderboard, and publishes a takedown alert", async (t) => {
  if (skipIfNoCredentials(t)) return;

  process.env.S3_BUCKET_NAME = "test-bucket";
  process.env.CLOUDFRONT_DISTRIBUTION_ID = "TESTDISTID";
  process.env.SNS_ALERTS_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:test-topic";

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { createReport } = await import("../lib/db.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler, s3, cloudfront, sns } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_takedown_${Date.now()}`;
  const creatorId = `test_sh_takedown_creator_${Date.now()}`;
  const feedSK = `${padScore(0)}#${memeId}`;
  const s3Key = `uploads/${creatorId}/${memeId}.png`;
  const reportIdentity = `reporter_${Date.now()}`;

  // Seed as if INSERT already ran (feed item + leaderboard count of 1) and a
  // report already exists (the takedown SNS body needs reason/reporterCount).
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: "FEED#GLOBAL", SK: feedSK, memeId, creatorId, s3Key, score: 0 },
    })
  );
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}`, creatorId, memeCount: 1 },
    })
  );
  await createReport({ memeId, identityHash: reportIdentity, reason: "graphic content" });

  const s3Calls = [];
  const cfCalls = [];
  const snsCalls = [];
  const originalS3Send = s3.send;
  const originalCfSend = cloudfront.send;
  const originalSnsSend = sns.send;
  s3.send = async (command) => {
    s3Calls.push(command.input);
    return {};
  };
  cloudfront.send = async (command) => {
    cfCalls.push(command.input);
    return {};
  };
  sns.send = async (command) => {
    snsCalls.push(command.input);
    return {};
  };

  try {
    await handler(
      streamEvent(
        "MODIFY",
        memeImageWithStatus(memeId, creatorId, "removed", { removedBy: "admin-sub-123" }),
        memeImageWithStatus(memeId, creatorId, "active")
      ),
      {},
      () => {}
    );

    assert.strictEqual(s3Calls.length, 1, "S3 delete is called exactly once");
    assert.strictEqual(s3Calls[0].Bucket, "test-bucket");
    assert.strictEqual(s3Calls[0].Key, s3Key);

    assert.strictEqual(cfCalls.length, 1, "CloudFront invalidation is called exactly once");
    assert.strictEqual(cfCalls[0].DistributionId, "TESTDISTID");
    assert.deepStrictEqual(cfCalls[0].InvalidationBatch.Paths.Items, [`/${s3Key}`]);

    assert.strictEqual(snsCalls.length, 1, "takedown alert is published exactly once");
    assert.match(snsCalls[0].Subject, new RegExp(`MemeDay takedown: ${memeId}`));
    assert.match(snsCalls[0].Message, /reason: graphic content/);
    assert.match(snsCalls[0].Message, /distinct reporters: 1/);
    assert.match(snsCalls[0].Message, /operator: admin-sub-123/);

    const feedItem = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } })
    );
    assert.strictEqual(feedItem.Item, undefined, "takedown removes the meme from the feed, same as pending_review");

    const lbItem = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` } })
    );
    assert.strictEqual(lbItem.Item, undefined, "leaderboard count is decremented, and a row that reaches 0 is deleted");
  } finally {
    s3.send = originalS3Send;
    cloudfront.send = originalCfSend;
    sns.send = originalSnsSend;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `REPORT#${reportIdentity}` } }));
  }
});

test("stream-handler: a takedown SNS publish failure is caught — the S3 delete and CloudFront invalidation still happened", async (t) => {
  if (skipIfNoCredentials(t)) return;

  process.env.S3_BUCKET_NAME = "test-bucket";
  process.env.CLOUDFRONT_DISTRIBUTION_ID = "TESTDISTID";
  process.env.SNS_ALERTS_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:test-topic";

  const { handler, s3, cloudfront, sns } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_takedown_snsfail_${Date.now()}`;
  const creatorId = `test_sh_takedown_snsfail_creator_${Date.now()}`;

  let s3Called = false;
  let cfCalled = false;
  const originalS3Send = s3.send;
  const originalCfSend = cloudfront.send;
  const originalSnsSend = sns.send;
  const originalConsoleError = console.error;
  console.error = () => {};
  s3.send = async () => {
    s3Called = true;
    return {};
  };
  cloudfront.send = async () => {
    cfCalled = true;
    return {};
  };
  sns.send = async () => {
    throw new Error("simulated SNS outage");
  };

  try {
    await assert.doesNotReject(
      handler(
        streamEvent(
          "MODIFY",
          memeImageWithStatus(memeId, creatorId, "removed"),
          memeImageWithStatus(memeId, creatorId, "active")
        ),
        {},
        () => {}
      ),
      "a broken alerts topic must not fail the takedown"
    );
    assert.strictEqual(s3Called, true, "S3 delete still happened despite the later SNS failure");
    assert.strictEqual(cfCalled, true, "CloudFront invalidation still happened despite the later SNS failure");
  } finally {
    s3.send = originalS3Send;
    cloudfront.send = originalCfSend;
    sns.send = originalSnsSend;
    console.error = originalConsoleError;
  }
});

test("stream-handler: a meme already in pending_review can still be taken down (takedown check is independent of the wasClean/isClean feed branch)", async (t) => {
  if (skipIfNoCredentials(t)) return;

  process.env.S3_BUCKET_NAME = "test-bucket";
  process.env.CLOUDFRONT_DISTRIBUTION_ID = "TESTDISTID";
  process.env.SNS_ALERTS_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:test-topic";

  const { handler, s3, cloudfront, sns } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_takedown_pending_${Date.now()}`;
  const creatorId = `test_sh_takedown_pending_creator_${Date.now()}`;

  let s3Called = false;
  const originalS3Send = s3.send;
  const originalCfSend = cloudfront.send;
  const originalSnsSend = sns.send;
  s3.send = async () => {
    s3Called = true;
    return {};
  };
  cloudfront.send = async () => ({});
  sns.send = async () => ({});

  try {
    // Neither wasClean nor isClean (pending_review -> removed are both
    // non-feed-eligible), so the feed/leaderboard branch does nothing — the
    // takedown side effects must still fire.
    await handler(
      streamEvent(
        "MODIFY",
        memeImageWithStatus(memeId, creatorId, "removed"),
        memeImageWithStatus(memeId, creatorId, "pending_review")
      ),
      {},
      () => {}
    );
    assert.strictEqual(s3Called, true, "takedown still runs even when the prior status was already non-feed-eligible");
  } finally {
    s3.send = originalS3Send;
    cloudfront.send = originalCfSend;
    sns.send = originalSnsSend;
  }
});

// ── KAN-43 follow-up: REPORTQUEUE#GLOBAL materialized view ──────────────────

test("stream-handler: a REPORT# insert creates one REPORTQUEUE#GLOBAL item; a second reporter increments the distinct count without a second item", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_queue_${Date.now()}`;
  const creatorId = `test_sh_queue_creator_${Date.now()}`;
  const s3Key = `uploads/${creatorId}/${memeId}.png`;
  const queueKey = { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeId}` };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, s3Key, status: "active" },
    })
  );

  try {
    await handler(
      streamEvent("INSERT", reportImage(memeId, "hash-a", "spam", "2024-01-01T00:00:00.000Z")),
      {},
      () => {}
    );

    const afterFirst = await dynamo.send(new GetCommand({ TableName: TABLE, Key: queueKey }));
    assert.ok(afterFirst.Item, "queue item created on first report");
    assert.strictEqual(afterFirst.Item.creatorId, creatorId, "creatorId denormalized from the base meme item");
    assert.strictEqual(afterFirst.Item.s3Key, s3Key, "s3Key denormalized from the base meme item");
    assert.strictEqual(afterFirst.Item.reason, "spam");
    assert.strictEqual(afterFirst.Item.firstReportedAt, "2024-01-01T00:00:00.000Z");
    assert.strictEqual(afterFirst.Item.reporterHashes.size, 1);

    await handler(
      streamEvent("INSERT", reportImage(memeId, "hash-b", "different reason", "2024-01-02T00:00:00.000Z")),
      {},
      () => {}
    );

    const afterSecond = await dynamo.send(new GetCommand({ TableName: TABLE, Key: queueKey }));
    assert.strictEqual(afterSecond.Item.reason, "spam", "reason stays the first report's, not the second's");
    assert.strictEqual(afterSecond.Item.firstReportedAt, "2024-01-01T00:00:00.000Z", "firstReportedAt is not overwritten");
    assert.strictEqual(afterSecond.Item.lastReportedAt, "2024-01-02T00:00:00.000Z", "lastReportedAt tracks the latest report");
    assert.strictEqual(afterSecond.Item.reporterHashes.size, 2, "a second distinct reporter increments the count");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: queueKey }));
  }
});

test("stream-handler: a replayed REPORT# insert (same identity) does not double count", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_replay_${Date.now()}`;
  const creatorId = `test_sh_replay_creator_${Date.now()}`;
  const s3Key = `uploads/${creatorId}/${memeId}.png`;
  const queueKey = { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeId}` };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, s3Key, status: "active" },
    })
  );

  try {
    const event = streamEvent("INSERT", reportImage(memeId, "hash-replayed", "spam", "2024-01-01T00:00:00.000Z"));

    // DynamoDB Streams is at-least-once — deliver the identical record twice.
    await handler(event, {}, () => {});
    await handler(event, {}, () => {});

    const { Item } = await dynamo.send(new GetCommand({ TableName: TABLE, Key: queueKey }));
    assert.strictEqual(Item.reporterHashes.size, 1, "the same identity hash replayed twice is still one distinct reporter");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: queueKey }));
  }
});

test("stream-handler: takedown removes the REPORTQUEUE#GLOBAL item", async (t) => {
  if (skipIfNoCredentials(t)) return;

  process.env.S3_BUCKET_NAME = "test-bucket";
  process.env.CLOUDFRONT_DISTRIBUTION_ID = "TESTDISTID";
  process.env.SNS_ALERTS_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:test-topic";

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler, s3, cloudfront, sns } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_queue_takedown_${Date.now()}`;
  const creatorId = `test_sh_queue_takedown_creator_${Date.now()}`;
  const queueKey = { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeId}` };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: "REPORTQUEUE#GLOBAL",
        SK: `MEME#${memeId}`,
        memeId,
        creatorId,
        s3Key: `uploads/${creatorId}/${memeId}.png`,
        reason: "spam",
        firstReportedAt: "2024-01-01T00:00:00.000Z",
        lastReportedAt: "2024-01-01T00:00:00.000Z",
        reporterHashes: new Set(["hash-a"]),
      },
    })
  );

  const originalS3Send = s3.send;
  const originalCfSend = cloudfront.send;
  const originalSnsSend = sns.send;
  s3.send = async () => ({});
  cloudfront.send = async () => ({});
  sns.send = async () => ({});

  try {
    await handler(
      streamEvent(
        "MODIFY",
        memeImageWithStatus(memeId, creatorId, "removed"),
        memeImageWithStatus(memeId, creatorId, "active")
      ),
      {},
      () => {}
    );

    const { Item } = await dynamo.send(new GetCommand({ TableName: TABLE, Key: queueKey }));
    assert.strictEqual(Item, undefined, "the queue item is gone once the meme is taken down");
  } finally {
    s3.send = originalS3Send;
    cloudfront.send = originalCfSend;
    sns.send = originalSnsSend;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: queueKey }));
  }
});

// ── KAN-67: no view row without its parent ──────────────────────────────────
// Every test below goes through the in-process handler only (no real MEME#
// item is written), so the deployed StreamHandler never reacts to it.

test("stream-handler: INSERT for a creator with no USER# item writes no LEADERBOARD#GLOBAL row", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler, cloudwatch } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_nouser_${Date.now()}`;
  const creatorId = `test_sh_nouser_creator_${Date.now()}`; // deliberately never seeded
  const feedKey = { PK: "FEED#GLOBAL", SK: `${padScore(0)}#${memeId}` };
  const lbKey = { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` };
  const uploadAward = await uploadAwardKeys(creatorId, memeId, IMAGE_CREATED_AT);

  // The skipped UPLOAD award emits PointsAwardSkipped: stub it so the test
  // does not publish a real metric (test/points.test.js asserts on it).
  const originalCwSend = cloudwatch.send;
  const originalConsoleWarn = console.warn;
  cloudwatch.send = async () => ({});
  console.warn = () => {};

  try {
    await handler(streamEvent("INSERT", memeImage(memeId, creatorId, 0)), {}, () => {});

    const lbItem = await dynamo.send(new GetCommand({ TableName: TABLE, Key: lbKey }));
    assert.strictEqual(lbItem.Item, undefined, "no leaderboard row for a creator who has no USER# item");

    const feedItem = await dynamo.send(new GetCommand({ TableName: TABLE, Key: feedKey }));
    assert.ok(feedItem.Item, "the feed item hangs off the meme, not the user, so it is still written");
  } finally {
    cloudwatch.send = originalCwSend;
    console.warn = originalConsoleWarn;
    await deleteKeys(dynamo, TABLE, [feedKey, lbKey, uploadAward.award, ...uploadAward.totals]);
  }
});

test("stream-handler: a leaderboard decrement on a missing row creates no row", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_dec_missing_${Date.now()}`;
  const creatorId = `test_sh_dec_missing_creator_${Date.now()}`;
  const lbKey = { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` };

  try {
    // REMOVE of a clean meme decrements; nothing was ever counted for this creator.
    await handler(streamEvent("REMOVE", null, memeImage(memeId, creatorId, 0)), {}, () => {});

    const lbItem = await dynamo.send(new GetCommand({ TableName: TABLE, Key: lbKey }));
    assert.strictEqual(lbItem.Item, undefined, "a decrement never creates a row (it used to create one at memeCount -1)");
  } finally {
    await deleteKeys(dynamo, TABLE, [lbKey]);
  }
});

test("stream-handler: a decrement that brings memeCount to 0 deletes the LEADERBOARD#GLOBAL row", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_dec_zero_${Date.now()}`;
  const creatorId = `test_sh_dec_zero_creator_${Date.now()}`;
  const lbKey = { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` };

  await dynamo.send(new PutCommand({ TableName: TABLE, Item: { ...lbKey, creatorId, memeCount: 1 } }));

  try {
    await handler(streamEvent("REMOVE", null, memeImage(memeId, creatorId, 0)), {}, () => {});

    const lbItem = await dynamo.send(new GetCommand({ TableName: TABLE, Key: lbKey }));
    assert.strictEqual(lbItem.Item, undefined, "the creator's last meme is gone, so the row is deleted rather than left at 0");
  } finally {
    await deleteKeys(dynamo, TABLE, [lbKey]);
  }
});

test("stream-handler: REMOVE of a clean meme reverses its UPLOAD award, deletes LB# totals that reach 0, and deletes the REPORTQUEUE#GLOBAL row", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_remove_clean_${Date.now()}`;
  const creatorId = `test_sh_remove_clean_creator_${Date.now()}`;
  const feedKey = { PK: "FEED#GLOBAL", SK: `${padScore(0)}#${memeId}` };
  const lbKey = { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` };
  const queueKey = { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeId}` };
  const uploadAward = await uploadAwardKeys(creatorId, memeId, IMAGE_CREATED_AT);

  await seedUser(dynamo, TABLE, creatorId);
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...queueKey, memeId, creatorId, reason: "spam", reporterHashes: new Set(["hash-a"]) },
    })
  );

  try {
    // The meme is published: feed item, memeCount 1, 10 UPLOAD points.
    await handler(streamEvent("INSERT", memeImage(memeId, creatorId, 0)), {}, () => {});

    const awardBefore = await dynamo.send(new GetCommand({ TableName: TABLE, Key: uploadAward.award }));
    assert.ok(awardBefore.Item, "sanity check: the UPLOAD award exists before the meme is deleted");
    for (const key of uploadAward.totals) {
      const total = await dynamo.send(new GetCommand({ TableName: TABLE, Key: key }));
      assert.strictEqual(total.Item?.points, 10, `sanity check: ${key.PK} holds the UPLOAD points before the delete`);
    }

    // The MEME# item is hard-deleted (what the manual removal runbook does).
    await handler(streamEvent("REMOVE", null, memeImage(memeId, creatorId, 0)), {}, () => {});

    const awardAfter = await dynamo.send(new GetCommand({ TableName: TABLE, Key: uploadAward.award }));
    assert.strictEqual(awardAfter.Item, undefined, "the UPLOAD award is reversed");
    for (const key of uploadAward.totals) {
      const total = await dynamo.send(new GetCommand({ TableName: TABLE, Key: key }));
      assert.strictEqual(total.Item, undefined, `${key.PK} reached 0 and is deleted, not left as a 0-point row`);
    }

    const queueItem = await dynamo.send(new GetCommand({ TableName: TABLE, Key: queueKey }));
    assert.strictEqual(queueItem.Item, undefined, "the report queue row for the deleted meme is gone");

    const feedItem = await dynamo.send(new GetCommand({ TableName: TABLE, Key: feedKey }));
    assert.strictEqual(feedItem.Item, undefined, "the feed item is gone");

    const lbItem = await dynamo.send(new GetCommand({ TableName: TABLE, Key: lbKey }));
    assert.strictEqual(lbItem.Item, undefined, "the leaderboard row reached 0 and is deleted");
  } finally {
    await deleteKeys(dynamo, TABLE, [
      userKey(creatorId),
      feedKey,
      lbKey,
      queueKey,
      uploadAward.award,
      ...uploadAward.totals,
    ]);
  }
});

test("stream-handler: REMOVE of a pending_review meme deletes its REPORTQUEUE#GLOBAL row without a second leaderboard decrement", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_sh_remove_pending_${Date.now()}`;
  const creatorId = `test_sh_remove_pending_creator_${Date.now()}`;
  const lbKey = { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` };
  const queueKey = { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeId}` };

  // The creator's two other memes are still counted. This one already lost
  // its count when it was flagged (the MODIFY to pending_review).
  await dynamo.send(new PutCommand({ TableName: TABLE, Item: { ...lbKey, creatorId, memeCount: 2 } }));
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...queueKey, memeId, creatorId, reason: "spam", reporterHashes: new Set(["hash-a"]) },
    })
  );

  try {
    await handler(
      streamEvent("REMOVE", null, memeImageWithStatus(memeId, creatorId, "pending_review")),
      {},
      () => {}
    );

    const queueItem = await dynamo.send(new GetCommand({ TableName: TABLE, Key: queueKey }));
    assert.strictEqual(queueItem.Item, undefined, "the queue row is deleted even though the meme was not feed-eligible");

    const lbItem = await dynamo.send(new GetCommand({ TableName: TABLE, Key: lbKey }));
    assert.strictEqual(lbItem.Item.memeCount, 2, "no double decrement: the flag already took this meme's count");
  } finally {
    await deleteKeys(dynamo, TABLE, [lbKey, queueKey]);
  }
});
