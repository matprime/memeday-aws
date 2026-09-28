const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// Exercises getPointsLeaderboardRows (KAN-101) against
// test/helpers/db-dynamo-stub.mjs instead of a live DynamoDB table, so the
// orphan-row paging logic runs without AWS credentials.
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

function padPoints(n) {
  return Math.max(0, n).toString().padStart(15, "0");
}

// Pushes an orphan (no USER# record) leaderboard row into GSI3.
function seedOrphanRow(feedItems, userId, points) {
  feedItems.push({
    GSI3PK: "LB#ALLTIME",
    GSI3SK: `${padPoints(points)}#${userId}`,
    userId,
    points,
  });
}

// Pushes a real leaderboard row into GSI3 and its backing USER# record.
function seedRealRow(feedItems, seedItem, userId, points) {
  seedOrphanRow(feedItems, userId, points);
  seedItem(`USER#${userId}`, `USER#${userId}`, {
    userId,
    displayName: `user-${userId}`,
    authMethods: [],
    credScore: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

test("getPointsLeaderboardRows returns real users ranked below a wall of orphan rows", async () => {
  const { getPointsLeaderboardRows } = await load("lib/db.ts");
  const { state, resetStub, seedItem } = await loadStub();
  resetStub();

  // 60 orphan rows outrank 3 real users, spanning the 50-row page boundary.
  for (let i = 0; i < 60; i++) {
    seedOrphanRow(state.feedItems, `orphan-${i}`, 1000 - i);
  }
  seedRealRow(state.feedItems, seedItem, "real-1", 30);
  seedRealRow(state.feedItems, seedItem, "real-2", 20);
  seedRealRow(state.feedItems, seedItem, "real-3", 10);

  const rows = await getPointsLeaderboardRows("all");

  assert.deepStrictEqual(
    rows.map((r) => r.userId),
    ["real-1", "real-2", "real-3"],
    "real users below the orphan wall are still found and stay in points order"
  );
});

test("getPointsLeaderboardRows stops once it has 50 real rows", async () => {
  const { getPointsLeaderboardRows } = await load("lib/db.ts");
  const { state, resetStub, seedItem } = await loadStub();
  resetStub();

  for (let i = 0; i < 60; i++) {
    seedRealRow(state.feedItems, seedItem, `real-${i}`, 1000 - i);
  }

  const rows = await getPointsLeaderboardRows("all");

  assert.strictEqual(rows.length, 50, "caps at 50 real rows");
  assert.strictEqual(state.queryCallCount, 1, "one page already had 50 real rows, no second page fetched");
});

test("getPointsLeaderboardRows stops at the 5-page cap when real rows never fill up", async () => {
  const { getPointsLeaderboardRows } = await load("lib/db.ts");
  const { state, resetStub, seedItem } = await loadStub();
  resetStub();

  // 5 full pages of orphans (250 rows), plus one real user just past the cap.
  for (let i = 0; i < 250; i++) {
    seedOrphanRow(state.feedItems, `orphan-${i}`, 10000 - i);
  }
  seedRealRow(state.feedItems, seedItem, "real-beyond-cap", 1);

  const rows = await getPointsLeaderboardRows("all");

  assert.deepStrictEqual(rows, [], "the one real row past the 5-page cap is never reached");
  assert.strictEqual(state.queryCallCount, 5, "reads exactly 5 pages, not more");
});

test("getPointsLeaderboardRows returns [] for an empty index", async () => {
  const { getPointsLeaderboardRows } = await load("lib/db.ts");
  const { state, resetStub } = await loadStub();
  resetStub();

  const rows = await getPointsLeaderboardRows("all");

  assert.deepStrictEqual(rows, []);
  assert.strictEqual(state.queryCallCount, 1, "one page is enough to see the index is empty");
});
