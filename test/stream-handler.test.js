const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

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

function skipIfNoCredentials(t) {
  if (!process.env.DYNAMODB_TABLE_NAME || !process.env.AWS_ACCESS_KEY_ID) {
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
