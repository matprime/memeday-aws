const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { randomUUID } = require("node:crypto");
const { hasAwsCredentials } = require("./helpers/aws-credentials");

// Same .env loading as the other integration tests (see meme-listing.test.js).
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

// Zero-pad to 15 digits, same derivation as lambdas/stream-handler/index.ts,
// so a directly-seeded feed item lands at the same SK a real StreamHandler
// write would use.
function padScore(n) {
  return Math.max(0, n).toString().padStart(15, "0");
}

// Seeds both halves of a feed entry (the MEME# item getFeedPage BatchGets,
// and the FEED#GLOBAL/GSI3 item it queries) with a single direct PutCommand
// each, bypassing createMeme entirely so DynamoDB Streams never fires and
// can't recreate either item out from under this test's cleanup.
async function seedFeedMeme(dynamo, TABLE, { memeId, creatorId, createdAt, score = 0 }) {
  const { PutCommand } = require("@aws-sdk/lib-dynamodb");
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `MEME#${memeId}`,
        SK: `MEME#${memeId}`,
        memeId,
        creatorId,
        ownerId: creatorId,
        s3Key: `test/${memeId}.jpg`,
        caption: "browse feed page test",
        status: "active",
        likeCount: 0,
        commentCount: 0,
        score,
        createdAt,
      },
    })
  );
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: "FEED#GLOBAL",
        SK: `${padScore(score)}#${memeId}`,
        GSI3PK: "FEED#GLOBAL",
        GSI3SK: createdAt,
        memeId,
        creatorId,
        s3Key: `test/${memeId}.jpg`,
        caption: "browse feed page test",
        score,
      },
    })
  );
}

async function deleteFeedMeme(dynamo, TABLE, { memeId, score = 0 }) {
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } }));
  await dynamo.send(
    new DeleteCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: `${padScore(score)}#${memeId}` } })
  );
}

test("getFeedPage: a meme inside the 7 day window is returned for range=week", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { getFeedPage } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");

  const memeId = randomUUID();
  const creatorId = `test-browse-inwindow-${Date.now()}`;
  const createdAt = new Date().toISOString();

  try {
    await seedFeedMeme(dynamo, TABLE, { memeId, creatorId, createdAt });
    const { memes } = await getFeedPage("week");
    assert.ok(memes.some((m) => m.id === memeId), "a meme created just now is inside the 7 day window");
  } finally {
    await deleteFeedMeme(dynamo, TABLE, { memeId });
  }
});

test("getFeedPage: a meme before the cutoff is not returned for range=week, but is for range=all", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { getFeedPage } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");

  const memeId = randomUUID();
  const creatorId = `test-browse-outwindow-${Date.now()}`;
  const createdAt = new Date(Date.now() - 10 * 86400000).toISOString(); // 10 days ago

  try {
    await seedFeedMeme(dynamo, TABLE, { memeId, creatorId, createdAt });

    // "week" must never return it, on any page, since the cutoff is applied
    // as a DynamoDB-side KeyConditionExpression, not a post-filter.
    let found = false;
    let cursor;
    for (let i = 0; i < 300 && !found; i++) {
      const page = await getFeedPage("week", cursor);
      found = page.memes.some((m) => m.id === memeId);
      cursor = page.nextCursor ?? undefined;
      if (!page.nextCursor) break;
    }
    assert.strictEqual(found, false, "a meme older than 7 days must not appear anywhere in range=week");

    // "all" has no cutoff, so the same meme is reachable there.
    found = false;
    cursor = undefined;
    for (let i = 0; i < 300 && !found; i++) {
      const page = await getFeedPage("all", cursor);
      found = page.memes.some((m) => m.id === memeId);
      cursor = page.nextCursor ?? undefined;
      if (!page.nextCursor) break;
    }
    assert.strictEqual(found, true, "range=all has no cutoff, so a 10-day-old meme is still reachable");
  } finally {
    await deleteFeedMeme(dynamo, TABLE, { memeId });
  }
});

test("getFeedPage: pagination returns correct order, no duplicates, and null nextCursor on the last page", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { getFeedPage } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");

  // 26 items with strictly decreasing createdAt (index 0 = newest), all
  // seconds-ago from "now" so they sort ahead of any real pre-existing data
  // and force at least two pages at the default page size of 24.
  const creatorId = `test-browse-page-${Date.now()}`;
  const base = Date.now();
  const seeded = Array.from({ length: 26 }, (_, i) => ({
    memeId: randomUUID(),
    creatorId,
    createdAt: new Date(base - i * 1000).toISOString(),
  }));

  try {
    for (const item of seeded) {
      await seedFeedMeme(dynamo, TABLE, item);
    }

    const seededIds = new Set(seeded.map((s) => s.memeId));
    const allIds = [];
    const allCreatedAt = [];
    let cursor;
    let lastPage;
    for (let i = 0; i < 300; i++) {
      const page = await getFeedPage("all", cursor);
      lastPage = page;
      for (const m of page.memes) {
        allIds.push(m.id);
        allCreatedAt.push(m.createdAt);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      assert.ok(i < 299, "feed pagination did not terminate within 300 pages");
    }

    assert.strictEqual(lastPage.nextCursor, null, "the last page's nextCursor is null");

    // No duplicates across the whole walk.
    assert.strictEqual(new Set(allIds).size, allIds.length, "no memeId is returned twice across pages");

    // Global order: newest first end-to-end, not just within a page.
    for (let i = 1; i < allCreatedAt.length; i++) {
      assert.ok(
        allCreatedAt[i - 1] >= allCreatedAt[i],
        `expected non-increasing createdAt order at index ${i}`
      );
    }

    // All 26 seeded items surfaced exactly once.
    const foundSeeded = allIds.filter((id) => seededIds.has(id));
    assert.strictEqual(foundSeeded.length, seeded.length, "every seeded meme was returned exactly once");
  } finally {
    for (const item of seeded) {
      await deleteFeedMeme(dynamo, TABLE, item);
    }
  }
});

test("getFeedPage: a tampered cursor (garbage base64 or wrong GSI3PK) falls back to page 1", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { getFeedPage } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");

  // The week feed has no upper bound on createdAt (only a lower-bound cutoff
  // in lib/db.ts), so a few minutes in the future still sorts newest-first
  // and is guaranteed to land on page 1 no matter what else other test
  // files are writing to the shared table at the same time.
  const memeId = randomUUID();
  const creatorId = `test-browse-tampered-${Date.now()}`;
  const createdAt = new Date(Date.now() + 5 * 60000).toISOString();

  try {
    await seedFeedMeme(dynamo, TABLE, { memeId, creatorId, createdAt });

    const garbage = await getFeedPage("week", "not-valid-base64url!!!");
    const wrongPk = await getFeedPage(
      "week",
      Buffer.from(JSON.stringify({ GSI3PK: "NOT#FEED", GSI3SK: "2020-01-01T00:00:00.000Z" }), "utf8").toString(
        "base64url"
      )
    );

    // If a tampered cursor were honored instead of ignored, DynamoDB would
    // either error on the malformed key or start the query from the wrong
    // place, so the seeded meme would not come back as the very first id.
    assert.strictEqual(garbage.memes[0]?.id, memeId, "garbage base64 cursor must be ignored, serving page 1");
    assert.strictEqual(wrongPk.memes[0]?.id, memeId, "a cursor with the wrong GSI3PK must be ignored, serving page 1");
  } finally {
    await deleteFeedMeme(dynamo, TABLE, { memeId });
  }
});
