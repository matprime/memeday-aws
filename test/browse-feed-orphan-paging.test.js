const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// Exercises getFeedPage's orphan-skipping paging logic (KAN-101 follow-up)
// against test/helpers/db-dynamo-stub.mjs instead of a live DynamoDB table,
// the same approach as points-leaderboard-paging.test.js.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/cache") {
      const stub = path.join(__dirname, "helpers", "next-cache-stub.mjs");
      return { url: pathToFileURL(stub).href, shortCircuit: true };
    }
    if (
      specifier === "./dynamo" &&
      context.parentURL?.endsWith("/lib/db.ts")
    ) {
      const stub = path.join(__dirname, "helpers", "db-dynamo-stub.mjs");
      return { url: pathToFileURL(stub).href, shortCircuit: true };
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

function loadStub() {
  return import(pathToFileURL(path.join(__dirname, "helpers", "db-dynamo-stub.mjs")).href);
}

function padScore(n) {
  return Math.max(0, n).toString().padStart(15, "0");
}

// `order` is this row's position in newest-first order (0 = newest); every
// row gets a distinct createdAt one second apart so GSI3SK sorts exactly by
// `order`, same derivation browse-feed-page.test.js uses against the real
// table.
function createdAtFor(order, base) {
  return new Date(base - order * 1000).toISOString();
}

function seedOrphanFeedRow(feedItems, { memeId, order, base }) {
  const createdAt = createdAtFor(order, base);
  feedItems.push({
    PK: "FEED#GLOBAL",
    SK: `${padScore(0)}#${memeId}`,
    GSI3PK: "FEED#GLOBAL",
    GSI3SK: createdAt,
    memeId,
  });
}

function seedRealFeedRow(feedItems, seedItem, { memeId, creatorId, order, base }) {
  const createdAt = createdAtFor(order, base);
  seedOrphanFeedRow(feedItems, { memeId, order, base });
  seedItem(`MEME#${memeId}`, `MEME#${memeId}`, {
    memeId,
    creatorId,
    ownerId: creatorId,
    s3Key: `test/${memeId}.jpg`,
    caption: "orphan paging test",
    status: "active",
    likeCount: 0,
    commentCount: 0,
    score: 0,
    createdAt,
  });
}

test("getFeedPage returns real memes behind a wall of orphan feed rows, across internal queries", async () => {
  const { getFeedPage } = await load("lib/db.ts");
  const { state, resetStub, seedItem } = await loadStub();
  resetStub();

  const base = Date.now();
  // 30 orphans outrank 3 real memes, spanning the 24-row query boundary.
  for (let i = 0; i < 30; i++) {
    seedOrphanFeedRow(state.feedItems, { memeId: `orphan-${i}`, order: i, base });
  }
  for (let i = 0; i < 3; i++) {
    seedRealFeedRow(state.feedItems, seedItem, {
      memeId: `real-${i}`,
      creatorId: `creator-${i}`,
      order: 30 + i,
      base,
    });
  }

  const { memes, nextCursor } = await getFeedPage("all");

  assert.deepStrictEqual(
    memes.map((m) => m.id),
    ["real-0", "real-1", "real-2"],
    "real memes below the orphan wall are still found, in newest-first order"
  );
  assert.strictEqual(nextCursor, null, "index is exhausted, so there is no next page");
  assert.strictEqual(state.queryCallCount, 2, "needed a second internal query to get past the orphan wall");
});

test("getFeedPage stops at the 5-query cap when real memes never fill the page", async () => {
  const { getFeedPage } = await load("lib/db.ts");
  const { state, resetStub, seedItem } = await loadStub();
  resetStub();

  const base = Date.now();
  // 5 full pages of orphans (120 rows), plus one real meme just past the cap.
  for (let i = 0; i < 120; i++) {
    seedOrphanFeedRow(state.feedItems, { memeId: `orphan-${i}`, order: i, base });
  }
  seedRealFeedRow(state.feedItems, seedItem, {
    memeId: "real-beyond-cap",
    creatorId: "creator-beyond-cap",
    order: 120,
    base,
  });

  const { memes, nextCursor } = await getFeedPage("all");

  assert.deepStrictEqual(memes, [], "the one real meme past the 5-query cap is never reached on this page");
  assert.strictEqual(state.queryCallCount, 5, "reads exactly 5 internal queries, not more");
  assert.notStrictEqual(nextCursor, null, "index is not exhausted, so a caller can still page into it");
});

test("getFeedPage: a page that fills up mid-batch resumes after the exact row, with no skip or duplicate", async () => {
  const { getFeedPage } = await load("lib/db.ts");
  const { state, resetStub, seedItem } = await loadStub();
  resetStub();

  const base = Date.now();
  let order = 0;

  // Batch 1 (positions 0-23, one internal query): 20 real + 4 orphans. Real
  // count (20) never reaches the page size of 24, so this batch is fully
  // consumed and the loop continues.
  for (let i = 0; i < 20; i++) {
    seedRealFeedRow(state.feedItems, seedItem, { memeId: `real-${i}`, creatorId: `creator-${i}`, order: order++, base });
  }
  for (let i = 0; i < 4; i++) {
    seedOrphanFeedRow(state.feedItems, { memeId: `orphan-a-${i}`, order: order++, base });
  }

  // Batch 2 (positions 24-47, second internal query): 4 more real memes
  // (bringing the running total to exactly 24, the page size) followed by 20
  // orphans. The page must stop right after the 4th real meme here, not
  // after the whole batch.
  for (let i = 0; i < 4; i++) {
    seedRealFeedRow(state.feedItems, seedItem, { memeId: `real-${20 + i}`, creatorId: `creator-${20 + i}`, order: order++, base });
  }
  for (let i = 0; i < 20; i++) {
    seedOrphanFeedRow(state.feedItems, { memeId: `orphan-b-${i}`, order: order++, base });
  }

  // One more real meme past everything above.
  seedRealFeedRow(state.feedItems, seedItem, { memeId: "real-24", creatorId: "creator-24", order: order++, base });

  const page1 = await getFeedPage("all");
  assert.deepStrictEqual(
    page1.memes.map((m) => m.id),
    Array.from({ length: 24 }, (_, i) => `real-${i}`),
    "page 1 returns exactly the first 24 real memes, in order"
  );
  assert.notStrictEqual(page1.nextCursor, null, "more real memes remain, just further down the index");

  const page2 = await getFeedPage("all", page1.nextCursor);
  assert.deepStrictEqual(
    page2.memes.map((m) => m.id),
    ["real-24"],
    "page 2 picks up exactly where page 1 stopped: no skipped or duplicated meme"
  );
  assert.strictEqual(page2.nextCursor, null, "page 2 exhausts the index");
});

test("getFeedPage returns an empty page with a null cursor for an empty index", async () => {
  const { getFeedPage } = await load("lib/db.ts");
  const { resetStub } = await loadStub();
  resetStub();

  const { memes, nextCursor } = await getFeedPage("all");

  assert.deepStrictEqual(memes, []);
  assert.strictEqual(nextCursor, null);
});
