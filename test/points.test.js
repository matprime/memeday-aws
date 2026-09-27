const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { hasAwsCredentials } = require("./helpers/aws-credentials");

// Same .env loading + extensionless-relative-import resolution as
// test/stream-handler.test.js — see that file for why this exists.
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
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(__dirname, "..", specifier.slice(2) + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
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

function load(rel) {
  return import(pathToFileURL(path.join(__dirname, "..", rel)).href);
}

function skipIfNoCredentials(t) {
  if (!process.env.DYNAMODB_TABLE_NAME || !hasAwsCredentials()) {
    t.skip("Missing DYNAMODB_TABLE_NAME or AWS credentials");
    return true;
  }
  return false;
}

function skipIfNoCognito(t) {
  if (
    !process.env.DYNAMODB_TABLE_NAME ||
    !process.env.COGNITO_USER_POOL_ID ||
    !process.env.COGNITO_CLIENT_ID ||
    !hasAwsCredentials()
  ) {
    t.skip("Missing DYNAMODB_TABLE_NAME, Cognito config, or AWS credentials");
    return true;
  }
  return false;
}

function padPoints(n) {
  return Math.max(0, n).toString().padStart(15, "0");
}

// Local copies of lib/points-config.ts's date-key helpers, used only to
// compute which LB#DAY#/LB#WEEK# keys today's awards will land in so tests
// can clean them up — same duplication convention test/stream-handler.test.js
// already uses for padScore rather than importing the Lambda's internals.
function utcDateKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// The three period-total keys a single award to `userId` (at `createdAt`) touches.
function periodTotalKeys(userId, createdAt) {
  const d = new Date(createdAt);
  return [
    { PK: `LB#DAY#${utcDateKey(d)}`, SK: `USER#${userId}` },
    { PK: `LB#WEEK#${isoWeekKey(d)}`, SK: `USER#${userId}` },
    { PK: "LB#ALLTIME", SK: `USER#${userId}` },
  ];
}

function memeImage(memeId, creatorId, status, createdAt) {
  return {
    PK: { S: `MEME#${memeId}` },
    SK: { S: `MEME#${memeId}` },
    memeId: { S: memeId },
    creatorId: { S: creatorId },
    ownerId: { S: creatorId },
    s3Key: { S: `uploads/${creatorId}/${memeId}.png` },
    caption: { S: "points test meme" },
    score: { N: "0" },
    likeCount: { N: "0" },
    commentCount: { N: "0" },
    status: { S: status },
    createdAt: { S: createdAt },
  };
}

function likeImage(memeId, likerUserId, createdAt) {
  return {
    PK: { S: `MEME#${memeId}` },
    SK: { S: `LIKE#${likerUserId}` },
    createdAt: { S: createdAt },
  };
}

function commentImage(memeId, commentId, userId, body, createdAt) {
  return {
    PK: { S: `MEME#${memeId}` },
    SK: { S: `COMMENT#${createdAt}#${commentId}` },
    commentId: { S: commentId },
    memeId: { S: memeId },
    userId: { S: userId },
    body: { S: body },
    createdAt: { S: createdAt },
  };
}

function userImage(userId, createdAt, referredBy) {
  const image = {
    PK: { S: `USER#${userId}` },
    SK: { S: `USER#${userId}` },
    userId: { S: userId },
    authMethods: { L: [] },
    credScore: { N: "0" },
    createdAt: { S: createdAt },
  };
  if (referredBy) image.referredBy = { S: referredBy };
  return image;
}

function streamEvent(eventName, newImage, oldImage) {
  const keySource = newImage ?? oldImage;
  const record = {
    eventName,
    dynamodb: { Keys: { PK: keySource.PK, SK: keySource.SK } },
  };
  if (newImage) record.dynamodb.NewImage = newImage;
  if (oldImage) record.dynamodb.OldImage = oldImage;
  return { Records: [record] };
}

async function cleanup(dynamo, DeleteCommand, TABLE, keys) {
  for (const key of keys) {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: key })).catch(() => {});
  }
}

test("points: a duplicate/replayed like award only awards once", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_pts_replay_${Date.now()}`;
  const creatorId = `test_pts_replay_creator_${Date.now()}`;
  const likerId = `test_pts_replay_liker_${Date.now()}`;
  const now = new Date().toISOString();

  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    { PK: `POINTS#${likerId}`, SK: `AWARD#GIVE_LIKE#${memeId}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_LIKE#${memeId}#${likerId}` },
    ...periodTotalKeys(likerId, now),
    ...periodTotalKeys(creatorId, now),
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, status: "active" },
    })
  );

  try {
    const event = streamEvent("INSERT", likeImage(memeId, likerId, now));

    // DynamoDB Streams is at-least-once — deliver the identical record twice.
    await handler(event, {}, () => {});
    await handler(event, {}, () => {});

    const award = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${likerId}`, SK: `AWARD#GIVE_LIKE#${memeId}` } })
    );
    assert.ok(award.Item, "give_like award exists");
    assert.strictEqual(award.Item.points, 1, "replayed record awards once, not twice");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: a self-like and a self-comment award nothing", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_pts_self_${Date.now()}`;
  const creatorId = `test_pts_self_creator_${Date.now()}`;
  const commentId = `test_pts_self_comment_${Date.now()}`;
  const now = new Date().toISOString();

  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#GIVE_LIKE#${memeId}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_LIKE#${memeId}#${creatorId}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#GIVE_COMMENT#${memeId}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_COMMENT#${commentId}` },
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, status: "active" },
    })
  );

  try {
    await handler(streamEvent("INSERT", likeImage(memeId, creatorId, now)), {}, () => {});
    await handler(
      streamEvent("INSERT", commentImage(memeId, commentId, creatorId, "a long enough self comment", now)),
      {},
      () => {}
    );

    for (const key of keys.slice(1)) {
      const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: key }));
      assert.strictEqual(result.Item, undefined, `no award for self-engagement at ${key.SK}`);
    }
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: a comment under 10 chars awards nothing; a second qualifying comment on the same meme does not re-award give_comment but does award receive_comment again", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_pts_comment_${Date.now()}`;
  const creatorId = `test_pts_comment_creator_${Date.now()}`;
  const commenterId = `test_pts_comment_commenter_${Date.now()}`;
  const shortCommentId = `test_pts_short_${Date.now()}`;
  const commentId1 = `test_pts_c1_${Date.now()}`;
  const commentId2 = `test_pts_c2_${Date.now()}`;
  const now = new Date().toISOString();

  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    { PK: `POINTS#${commenterId}`, SK: `AWARD#GIVE_COMMENT#${memeId}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_COMMENT#${shortCommentId}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_COMMENT#${commentId1}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_COMMENT#${commentId2}` },
    ...periodTotalKeys(commenterId, now),
    ...periodTotalKeys(creatorId, now),
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, status: "active" },
    })
  );

  try {
    // Under 10 chars — awards nothing for either side.
    await handler(
      streamEvent("INSERT", commentImage(memeId, shortCommentId, commenterId, "lol", now)),
      {},
      () => {}
    );
    const shortReceive = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_COMMENT#${shortCommentId}` } })
    );
    assert.strictEqual(shortReceive.Item, undefined, "a comment under 10 chars awards nothing");

    // Two separate qualifying comments, same commenter, same meme.
    await handler(
      streamEvent("INSERT", commentImage(memeId, commentId1, commenterId, "first qualifying comment", now)),
      {},
      () => {}
    );
    await handler(
      streamEvent("INSERT", commentImage(memeId, commentId2, commenterId, "second qualifying comment", now)),
      {},
      () => {}
    );

    const giveAward = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${commenterId}`, SK: `AWARD#GIVE_COMMENT#${memeId}` } })
    );
    assert.ok(giveAward.Item, "give_comment awarded once");
    assert.strictEqual(giveAward.Item.sourceId, memeId, "give_comment award recorded against the meme, not a specific comment");

    const receive1 = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_COMMENT#${commentId1}` } })
    );
    const receive2 = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_COMMENT#${commentId2}` } })
    );
    assert.ok(receive1.Item, "receive_comment awarded for the first comment");
    assert.ok(receive2.Item, "receive_comment awarded again for the second comment — it isn't per-meme deduped");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: a daily cap already at its ceiling blocks one more award of that action", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_pts_cap_${Date.now()}`;
  const creatorId = `test_pts_cap_creator_${Date.now()}`;
  const likerId = `test_pts_cap_liker_${Date.now()}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const dayKey = nowIso.slice(0, 10);

  // GIVE_LIKE: 1 point/award, cap 20 pts/day — seed the day counter already
  // at the ceiling so the next award is rejected outright, not truncated.
  const dayCounterKey = { PK: `POINTS#${likerId}`, SK: `DAY#${dayKey}#GIVE_LIKE` };
  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    dayCounterKey,
    { PK: `POINTS#${likerId}`, SK: `AWARD#GIVE_LIKE#${memeId}` },
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, status: "active" },
    })
  );
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...dayCounterKey, used: 20, expiresAt: Math.floor(Date.now() / 1000) + 86400 },
    })
  );

  try {
    await handler(streamEvent("INSERT", likeImage(memeId, likerId, nowIso)), {}, () => {});

    const award = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${likerId}`, SK: `AWARD#GIVE_LIKE#${memeId}` } })
    );
    assert.strictEqual(award.Item, undefined, "an award blocked by a full daily cap is not a partial award — it's no award");

    const counter = await dynamo.send(new GetCommand({ TableName: TABLE, Key: dayCounterKey }));
    assert.strictEqual(counter.Item.used, 20, "the day counter itself is untouched by a rejected award");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: flagging a published meme reverses its upload award and its qualifying referral award", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const referrerId = `test_pts_ref_referrer_${Date.now()}`;
  const referredId = `test_pts_ref_referred_${Date.now()}`;
  const memeId = `test_pts_ref_meme_${Date.now()}`;
  const userCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago, well inside the attach window
  const memeCreatedAt = new Date().toISOString();

  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    { PK: `LEADERBOARD#GLOBAL`, SK: `USER#${referredId}` },
    { PK: `POINTS#${referredId}`, SK: "REFERREDBY" },
    { PK: `POINTS#${referredId}`, SK: `AWARD#UPLOAD#${memeId}` },
    { PK: `POINTS#${referrerId}`, SK: `AWARD#REFERRAL#${referredId}` },
    ...periodTotalKeys(referredId, memeCreatedAt),
    ...periodTotalKeys(referrerId, memeCreatedAt),
  ];

  try {
    // 1. referrer's marker exists (simulates POST /api/users' referral attach
    //    landing as a USER# MODIFY carrying referredBy for the first time).
    await handler(
      streamEvent(
        "MODIFY",
        userImage(referredId, userCreatedAt, referrerId),
        userImage(referredId, userCreatedAt, undefined)
      ),
      {},
      () => {}
    );
    const marker = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${referredId}`, SK: "REFERREDBY" } })
    );
    assert.ok(marker.Item, "REFERREDBY marker written from a MODIFY, not just an INSERT");
    assert.strictEqual(marker.Item.referrerId, referrerId);

    // 2. the referred user's first clean meme — awards both UPLOAD and REFERRAL.
    await handler(streamEvent("INSERT", memeImage(memeId, referredId, "active", memeCreatedAt)), {}, () => {});

    const uploadAward = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${referredId}`, SK: `AWARD#UPLOAD#${memeId}` } })
    );
    const referralAward = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${referrerId}`, SK: `AWARD#REFERRAL#${referredId}` } })
    );
    assert.ok(uploadAward.Item, "upload award granted on the first clean meme");
    assert.ok(referralAward.Item, "referral award granted on the referred user's first clean meme");
    assert.strictEqual(referralAward.Item.qualifyingMemeId, memeId);

    // 3. flagged after publish — both awards must be reversed.
    await handler(
      streamEvent(
        "MODIFY",
        memeImage(memeId, referredId, "pending_review", memeCreatedAt),
        memeImage(memeId, referredId, "active", memeCreatedAt)
      ),
      {},
      () => {}
    );

    const uploadAfter = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${referredId}`, SK: `AWARD#UPLOAD#${memeId}` } })
    );
    const referralAfter = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${referrerId}`, SK: `AWARD#REFERRAL#${referredId}` } })
    );
    assert.strictEqual(uploadAfter.Item, undefined, "upload award reversed once the meme is flagged");
    assert.strictEqual(referralAfter.Item, undefined, "the qualifying referral award is reversed too");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: attaching a referrer after the referred user's first meme never awards a referral", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const referrerId = `test_pts_late_referrer_${Date.now()}`;
  const referredId = `test_pts_late_referred_${Date.now()}`;
  const memeId = `test_pts_late_meme_${Date.now()}`;
  const userCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const memeCreatedAt = new Date().toISOString();

  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    { PK: `LEADERBOARD#GLOBAL`, SK: `USER#${referredId}` },
    { PK: `POINTS#${referredId}`, SK: "REFERREDBY" },
    { PK: `POINTS#${referredId}`, SK: `AWARD#UPLOAD#${memeId}` },
    { PK: `POINTS#${referrerId}`, SK: `AWARD#REFERRAL#${referredId}` },
    ...periodTotalKeys(referredId, memeCreatedAt),
  ];

  try {
    // First clean meme lands BEFORE any referrer is attached.
    await handler(streamEvent("INSERT", memeImage(memeId, referredId, "active", memeCreatedAt)), {}, () => {});

    // Referrer attaches only now — too late, the first-meme check already ran.
    await handler(
      streamEvent(
        "MODIFY",
        userImage(referredId, userCreatedAt, referrerId),
        userImage(referredId, userCreatedAt, undefined)
      ),
      {},
      () => {}
    );

    const referralAward = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${referrerId}`, SK: `AWARD#REFERRAL#${referredId}` } })
    );
    assert.strictEqual(referralAward.Item, undefined, "attaching after the first meme never retroactively awards");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: attachReferrer — within the window succeeds; after the window, a second attach, and a self-ref are all ignored", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { attachReferrer } = await import("../lib/db.ts");

  const referrerId = `test_attach_referrer_${Date.now()}`;
  const referredId = `test_attach_referred_${Date.now()}`;
  const staleReferredId = `test_attach_stale_${Date.now()}`;

  const keys = [
    { PK: `USER#${referrerId}`, SK: `USER#${referrerId}` },
    { PK: `USER#${referredId}`, SK: `USER#${referredId}` },
    { PK: `USER#${staleReferredId}`, SK: `USER#${staleReferredId}` },
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `USER#${referrerId}`, SK: `USER#${referrerId}`, userId: referrerId, authMethods: [], credScore: 0, createdAt: new Date().toISOString() },
    })
  );
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `USER#${referredId}`, SK: `USER#${referredId}`, userId: referredId, authMethods: [], credScore: 0, createdAt: new Date().toISOString() },
    })
  );
  // Created 30 hours ago — outside the 24h REFERRAL_ATTACH_WINDOW_HOURS.
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USER#${staleReferredId}`,
        SK: `USER#${staleReferredId}`,
        userId: staleReferredId,
        authMethods: [],
        credScore: 0,
        createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      },
    })
  );

  try {
    // Self-ref: rejected by the caller (POST /api/users), not by attachReferrer
    // itself — attachReferrer has no self-check, so call it as the route would
    // never call it in that case. Confirm the route-level guard by asserting
    // the condition it's built on: attachReferrer("x","x") would otherwise
    // happily attach a user to themselves.
    const selfAttach = await attachReferrer(referredId, referredId);
    assert.strictEqual(selfAttach, true, "attachReferrer has no self-check — POST /api/users is the one that rejects ref === userId before ever calling it");

    // Clean slate: within-window attach on a fresh user.
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USER#${referredId}`, SK: `USER#${referredId}` },
        UpdateExpression: "REMOVE referredBy",
      })
    );
    const withinWindow = await attachReferrer(referredId, referrerId);
    assert.strictEqual(withinWindow, true, "attach within the window succeeds");
    const attached = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${referredId}`, SK: `USER#${referredId}` } })
    );
    assert.strictEqual(attached.Item.referredBy, referrerId);

    // Second attach on the same (now-attached) user is ignored.
    const secondAttach = await attachReferrer(referredId, `some_other_referrer_${Date.now()}`);
    assert.strictEqual(secondAttach, false, "a second attach is ignored");
    const stillFirst = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${referredId}`, SK: `USER#${referredId}` } })
    );
    assert.strictEqual(stillFirst.Item.referredBy, referrerId, "the first referrer is never overwritten");

    // Outside the window.
    const staleAttach = await attachReferrer(staleReferredId, referrerId);
    assert.strictEqual(staleAttach, false, "attach after the window is ignored");
    const stale = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${staleReferredId}`, SK: `USER#${staleReferredId}` } })
    );
    assert.strictEqual(stale.Item.referredBy, undefined);
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: GSI3SK's zero-padded points sort 100 above 99 in a leaderboard read", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { getPointsLeaderboard } = await import("../lib/db.ts");

  const user99 = `test_pts_sort_99_${Date.now()}`;
  const user100 = `test_pts_sort_100_${Date.now()}`;
  const keys = [
    { PK: "LB#ALLTIME", SK: `USER#${user99}` },
    { PK: "LB#ALLTIME", SK: `USER#${user100}` },
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: "LB#ALLTIME",
        SK: `USER#${user99}`,
        GSI3PK: "LB#ALLTIME",
        GSI3SK: `${padPoints(99)}#${user99}`,
        userId: user99,
        points: 99,
      },
    })
  );
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: "LB#ALLTIME",
        SK: `USER#${user100}`,
        GSI3PK: "LB#ALLTIME",
        GSI3SK: `${padPoints(100)}#${user100}`,
        userId: user100,
        points: 100,
      },
    })
  );

  try {
    const rows = await getPointsLeaderboard("all");
    const rank99 = rows.findIndex((r) => r.userId === user99);
    const rank100 = rows.findIndex((r) => r.userId === user100);
    assert.ok(rank100 !== -1 && rank99 !== -1, "both seeded rows come back");
    assert.ok(rank100 < rank99, "100 points sorts above (before) 99 points, descending");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

// ── Per-action daily caps ────────────────────────────────────────────────────
// Each seeds that action's DAY# counter already at its ceiling (see
// lib/points-config.ts POINTS_ACTIONS), then triggers one more qualifying
// event and asserts the award is rejected outright, not partially applied.

test("points: UPLOAD's daily cap (3 uploads/day) blocks a 4th", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_pts_cap_upload_${Date.now()}`;
  const creatorId = `test_pts_cap_upload_creator_${Date.now()}`;
  const now = new Date().toISOString();
  const dayKey = now.slice(0, 10);

  const dayCounterKey = { PK: `POINTS#${creatorId}`, SK: `DAY#${dayKey}#UPLOAD` };
  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` },
    dayCounterKey,
    { PK: `POINTS#${creatorId}`, SK: `AWARD#UPLOAD#${memeId}` },
  ];

  await dynamo.send(
    new PutCommand({ TableName: TABLE, Item: { ...dayCounterKey, used: 3, expiresAt: Math.floor(Date.now() / 1000) + 86400 } })
  );

  try {
    await handler(streamEvent("INSERT", memeImage(memeId, creatorId, "active", now)), {}, () => {});

    const award = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${creatorId}`, SK: `AWARD#UPLOAD#${memeId}` } })
    );
    assert.strictEqual(award.Item, undefined, "a 4th upload the same day earns nothing");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: RECEIVE_LIKE's daily cap (100 pts/day) blocks one more", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_pts_cap_recvlike_${Date.now()}`;
  const creatorId = `test_pts_cap_recvlike_creator_${Date.now()}`;
  const likerId = `test_pts_cap_recvlike_liker_${Date.now()}`;
  const now = new Date().toISOString();
  const dayKey = now.slice(0, 10);

  const dayCounterKey = { PK: `POINTS#${creatorId}`, SK: `DAY#${dayKey}#RECEIVE_LIKE` };
  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    dayCounterKey,
    { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_LIKE#${memeId}#${likerId}` },
    { PK: `POINTS#${likerId}`, SK: `AWARD#GIVE_LIKE#${memeId}` },
    ...periodTotalKeys(likerId, now),
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, status: "active" },
    })
  );
  await dynamo.send(
    new PutCommand({ TableName: TABLE, Item: { ...dayCounterKey, used: 100, expiresAt: Math.floor(Date.now() / 1000) + 86400 } })
  );

  try {
    await handler(streamEvent("INSERT", likeImage(memeId, likerId, now)), {}, () => {});

    const award = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_LIKE#${memeId}#${likerId}` } })
    );
    assert.strictEqual(award.Item, undefined, "receive_like earns nothing once the day's 100 points are used");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: GIVE_COMMENT's daily cap (10/day) blocks an 11th", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_pts_cap_givecomment_${Date.now()}`;
  const creatorId = `test_pts_cap_givecomment_creator_${Date.now()}`;
  const commenterId = `test_pts_cap_givecomment_commenter_${Date.now()}`;
  const commentId = `test_pts_cap_givecomment_comment_${Date.now()}`;
  const now = new Date().toISOString();
  const dayKey = now.slice(0, 10);

  const dayCounterKey = { PK: `POINTS#${commenterId}`, SK: `DAY#${dayKey}#GIVE_COMMENT` };
  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    dayCounterKey,
    { PK: `POINTS#${commenterId}`, SK: `AWARD#GIVE_COMMENT#${memeId}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_COMMENT#${commentId}` },
    ...periodTotalKeys(creatorId, now),
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, status: "active" },
    })
  );
  await dynamo.send(
    new PutCommand({ TableName: TABLE, Item: { ...dayCounterKey, used: 10, expiresAt: Math.floor(Date.now() / 1000) + 86400 } })
  );

  try {
    await handler(
      streamEvent("INSERT", commentImage(memeId, commentId, commenterId, "an eleventh qualifying comment", now)),
      {},
      () => {}
    );

    const award = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${commenterId}`, SK: `AWARD#GIVE_COMMENT#${memeId}` } })
    );
    assert.strictEqual(award.Item, undefined, "give_comment earns nothing past 10/day");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: RECEIVE_COMMENT's daily cap (50 pts/day) blocks one more", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_pts_cap_recvcomment_${Date.now()}`;
  const creatorId = `test_pts_cap_recvcomment_creator_${Date.now()}`;
  const commenterId = `test_pts_cap_recvcomment_commenter_${Date.now()}`;
  const commentId = `test_pts_cap_recvcomment_comment_${Date.now()}`;
  const now = new Date().toISOString();
  const dayKey = now.slice(0, 10);

  const dayCounterKey = { PK: `POINTS#${creatorId}`, SK: `DAY#${dayKey}#RECEIVE_COMMENT` };
  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    dayCounterKey,
    { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_COMMENT#${commentId}` },
    { PK: `POINTS#${commenterId}`, SK: `AWARD#GIVE_COMMENT#${memeId}` },
    ...periodTotalKeys(commenterId, now),
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, status: "active" },
    })
  );
  await dynamo.send(
    new PutCommand({ TableName: TABLE, Item: { ...dayCounterKey, used: 50, expiresAt: Math.floor(Date.now() / 1000) + 86400 } })
  );

  try {
    await handler(
      streamEvent("INSERT", commentImage(memeId, commentId, commenterId, "a comment past the receive cap", now)),
      {},
      () => {}
    );

    const award = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_COMMENT#${commentId}` } })
    );
    assert.strictEqual(award.Item, undefined, "receive_comment earns nothing once the day's 50 points are used");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: REFERRAL's daily cap (3/day) blocks a 4th referral award for the same referrer", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await import("../lambdas/stream-handler/index.ts");

  const referrerId = `test_pts_cap_referral_referrer_${Date.now()}`;
  const referredId = `test_pts_cap_referral_referred_${Date.now()}`;
  const memeId = `test_pts_cap_referral_meme_${Date.now()}`;
  const now = new Date().toISOString();
  const dayKey = now.slice(0, 10);

  const dayCounterKey = { PK: `POINTS#${referrerId}`, SK: `DAY#${dayKey}#REFERRAL` };
  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    { PK: "LEADERBOARD#GLOBAL", SK: `USER#${referredId}` },
    { PK: `POINTS#${referredId}`, SK: "REFERREDBY" },
    dayCounterKey,
    { PK: `POINTS#${referrerId}`, SK: `AWARD#REFERRAL#${referredId}` },
    { PK: `POINTS#${referredId}`, SK: `AWARD#UPLOAD#${memeId}` },
    ...periodTotalKeys(referredId, now),
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `POINTS#${referredId}`, SK: "REFERREDBY", referrerId, createdAt: now },
    })
  );
  await dynamo.send(
    new PutCommand({ TableName: TABLE, Item: { ...dayCounterKey, used: 3, expiresAt: Math.floor(Date.now() / 1000) + 86400 } })
  );

  try {
    await handler(streamEvent("INSERT", memeImage(memeId, referredId, "active", now)), {}, () => {});

    const referralAward = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${referrerId}`, SK: `AWARD#REFERRAL#${referredId}` } })
    );
    assert.strictEqual(referralAward.Item, undefined, "a referrer already at 3 referrals today gets no 4th");
  } finally {
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

// ── Reversal on "removed" (not just "pending_review") ───────────────────────

test("points: taking a meme down (status -> removed) also reverses its upload award", async (t) => {
  if (skipIfNoCredentials(t)) return;

  process.env.S3_BUCKET_NAME = "test-bucket";
  process.env.CLOUDFRONT_DISTRIBUTION_ID = "TESTDISTID";
  process.env.SNS_ALERTS_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:test-topic";

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler, s3, cloudfront, sns } = await import("../lambdas/stream-handler/index.ts");

  const creatorId = `test_pts_takedown_creator_${Date.now()}`;
  const memeId = `test_pts_takedown_meme_${Date.now()}`;
  const now = new Date().toISOString();

  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#UPLOAD#${memeId}` },
    ...periodTotalKeys(creatorId, now),
  ];

  const originalS3Send = s3.send;
  const originalCfSend = cloudfront.send;
  const originalSnsSend = sns.send;
  s3.send = async () => ({});
  cloudfront.send = async () => ({});
  sns.send = async () => ({});

  try {
    await handler(streamEvent("INSERT", memeImage(memeId, creatorId, "active", now)), {}, () => {});
    const before = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${creatorId}`, SK: `AWARD#UPLOAD#${memeId}` } })
    );
    assert.ok(before.Item, "upload award exists before takedown");

    await handler(
      streamEvent(
        "MODIFY",
        memeImage(memeId, creatorId, "removed", now),
        memeImage(memeId, creatorId, "active", now)
      ),
      {},
      () => {}
    );

    const after = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${creatorId}`, SK: `AWARD#UPLOAD#${memeId}` } })
    );
    assert.strictEqual(after.Item, undefined, "upload award is reversed on takedown (removed), same as pending_review");
  } finally {
    s3.send = originalS3Send;
    cloudfront.send = originalCfSend;
    sns.send = originalSnsSend;
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

// ── Self-ref rejection lives at the route layer ─────────────────────────────

test("points: POST /api/users ignores a ref equal to the caller's own userId", async (t) => {
  if (skipIfNoCognito(t)) return;

  const { POST } = await load("app/api/users/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { createTestCognitoSession } = require("./helpers/test-auth");

  const session = await createTestCognitoSession(`test-users-selfref-${Date.now()}`);
  try {
    const res = await POST(
      new Request("http://x/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ ref: session.userId }),
      })
    );
    assert.strictEqual(res.status, 200, "a self-ref must not error the profile write it rides with");

    const item = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${session.userId}`, SK: `USER#${session.userId}` } })
    );
    assert.strictEqual(item.Item?.referredBy, undefined, "ref === caller userId is never attached");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${session.userId}`, SK: `USER#${session.userId}` } }));
    await session.cleanup();
  }
});

// ── awardPoints retry on a genuine transaction conflict ─────────────────────

test("points: a TransactionConflict cancellation is retried and the award still lands", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler, docClient } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_pts_conflict_retry_${Date.now()}`;
  const creatorId = `test_pts_conflict_retry_creator_${Date.now()}`;
  const likerId = `test_pts_conflict_retry_liker_${Date.now()}`;
  const now = new Date().toISOString();

  const keys = [
    { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
    { PK: `POINTS#${likerId}`, SK: `AWARD#GIVE_LIKE#${memeId}` },
    { PK: `POINTS#${creatorId}`, SK: `AWARD#RECEIVE_LIKE#${memeId}#${likerId}` },
    ...periodTotalKeys(likerId, now),
    ...periodTotalKeys(creatorId, now),
  ];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, status: "active" },
    })
  );

  const originalSend = docClient.send.bind(docClient);
  let transactAttempts = 0;
  docClient.send = async (command) => {
    // Name-based check, not `instanceof TransactWriteCommand`: the test file's
    // require("@aws-sdk/lib-dynamodb") and the Lambda's ESM import of the same
    // package can land in different module instances under this test harness's
    // custom resolve hooks, so their classes aren't the same reference even
    // though they're structurally identical.
    if (command.constructor?.name === "TransactWriteCommand") {
      transactAttempts++;
      // Fail only the very first TransactWriteItems call this test sees
      // (GIVE_LIKE's first attempt) with a genuine conflict, not a
      // ConditionalCheckFailed — every later call, including GIVE_LIKE's own
      // retry, goes through untouched.
      if (transactAttempts === 1) {
        const err = new Error("simulated transaction conflict");
        err.name = "TransactionCanceledException";
        err.CancellationReasons = [
          { Code: "TransactionConflict" },
          { Code: "None" },
          { Code: "None" },
          { Code: "None" },
          { Code: "None" },
        ];
        throw err;
      }
    }
    return originalSend(command);
  };

  try {
    await handler(streamEvent("INSERT", likeImage(memeId, likerId, now)), {}, () => {});

    assert.ok(transactAttempts >= 2, "the transact call was retried after the simulated conflict");
    const award = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${likerId}`, SK: `AWARD#GIVE_LIKE#${memeId}` } })
    );
    assert.ok(award.Item, "the award still lands once the retry succeeds — a transient conflict doesn't lose it");
  } finally {
    docClient.send = originalSend;
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});

test("points: a persistent TransactionConflict exhausts retries and emits PointsAwardFailure instead of losing the award silently", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dynamo, TABLE } = await import("../lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler, docClient, cloudwatch } = await import("../lambdas/stream-handler/index.ts");

  const memeId = `test_pts_conflict_giveup_${Date.now()}`;
  const creatorId = `test_pts_conflict_giveup_creator_${Date.now()}`;
  const likerId = `test_pts_conflict_giveup_liker_${Date.now()}`;
  const now = new Date().toISOString();

  const keys = [{ PK: `MEME#${memeId}`, SK: `MEME#${memeId}` }];

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}`, memeId, creatorId, status: "active" },
    })
  );

  const originalSend = docClient.send.bind(docClient);
  const originalCwSend = cloudwatch.send;
  const originalConsoleError = console.error;
  console.error = () => {};
  let transactAttempts = 0;
  const metricCalls = [];
  docClient.send = async (command) => {
    if (command.constructor?.name === "TransactWriteCommand") {
      transactAttempts++;
      const err = new Error("simulated persistent conflict");
      err.name = "TransactionCanceledException";
      err.CancellationReasons = [{ Code: "TransactionConflict" }];
      throw err;
    }
    return originalSend(command);
  };
  cloudwatch.send = async (command) => {
    metricCalls.push(command.input);
    return {};
  };

  try {
    await handler(streamEvent("INSERT", likeImage(memeId, likerId, now)), {}, () => {});

    // Two independent awards (give_like, receive_like), each exhausting the
    // same 3-attempt budget against an always-failing transact.
    assert.strictEqual(transactAttempts, 6, "both awards retry 3 times each before giving up");
    assert.strictEqual(
      metricCalls.filter((c) => c.MetricData?.[0]?.MetricName === "PointsAwardFailure").length,
      2,
      "each exhausted award emits its own PointsAwardFailure, nothing fails silently"
    );

    const award = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${likerId}`, SK: `AWARD#GIVE_LIKE#${memeId}` } })
    );
    assert.strictEqual(award.Item, undefined, "no award is recorded when the transact never actually succeeded");
  } finally {
    docClient.send = originalSend;
    cloudwatch.send = originalCwSend;
    console.error = originalConsoleError;
    await cleanup(dynamo, DeleteCommand, TABLE, keys);
  }
});
