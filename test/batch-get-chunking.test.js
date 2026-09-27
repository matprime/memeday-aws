const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// Exercises the >100-key BatchGet helper in lib/db.ts (hydrateFeedItems,
// getReportedMemeIds) against test/helpers/db-dynamo-stub.mjs instead of a
// live DynamoDB table, so these run without AWS credentials.
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

test("hydrateFeedItems (via getMemes) returns all memes for more than 100 feed items", async () => {
  const { getMemes } = await load("lib/db.ts");
  const { state, resetStub, seedItem } = await loadStub();
  resetStub();

  const count = 150;
  for (let i = 0; i < count; i++) {
    const memeId = `meme-${i}`;
    const createdAt = new Date(2026, 0, 1, 0, 0, i).toISOString();
    state.feedItems.push({ memeId, GSI3PK: "FEED#GLOBAL", GSI3SK: createdAt });
    seedItem(`MEME#${memeId}`, `MEME#${memeId}`, {
      memeId,
      creatorId: "creator-1",
      ownerId: "creator-1",
      s3Key: `${memeId}.jpg`,
      caption: "hi",
      status: "active",
      likeCount: 0,
      commentCount: 0,
      score: 0,
      createdAt,
    });
  }

  const memes = await getMemes();

  assert.strictEqual(memes.length, count);
  assert.ok(state.batchCallCount >= 2, "expected more than one BatchGet call to be chunked");
  assert.ok(state.maxKeysPerCall <= 100, "no single BatchGet call should exceed 100 keys");
  // Preserves existing newest-first ordering behavior.
  assert.strictEqual(memes[0].id, "meme-149");
  assert.strictEqual(memes[memes.length - 1].id, "meme-0");
});

test("hydrateFeedItems retries UnprocessedKeys within a chunk", async () => {
  const { getMemes } = await load("lib/db.ts");
  const { state, resetStub, seedItem } = await loadStub();
  resetStub();
  state.splitFirstCall = true;

  for (let i = 0; i < 5; i++) {
    const memeId = `retry-meme-${i}`;
    const createdAt = new Date(2026, 0, 2, 0, 0, i).toISOString();
    state.feedItems.push({ memeId, GSI3PK: "FEED#GLOBAL", GSI3SK: createdAt });
    seedItem(`MEME#${memeId}`, `MEME#${memeId}`, {
      memeId,
      creatorId: "creator-1",
      ownerId: "creator-1",
      s3Key: `${memeId}.jpg`,
      caption: "hi",
      status: "active",
      likeCount: 0,
      commentCount: 0,
      score: 0,
      createdAt,
    });
  }

  const memes = await getMemes();

  assert.strictEqual(memes.length, 5);
  assert.ok(state.batchCallCount >= 2, "expected a retry call for the unprocessed keys");
});

test("getReportedMemeIds works for more than 100 ids", async () => {
  const { getReportedMemeIds } = await load("lib/db.ts");
  const { state, resetStub, seedItem } = await loadStub();
  resetStub();

  const identityHash = "identity-abc";
  const total = 150;
  const memeIds = Array.from({ length: total }, (_, i) => `rep-meme-${i}`);
  const reportedIds = memeIds.filter((_, i) => i % 3 === 0);

  for (const memeId of reportedIds) {
    seedItem(`MEME#${memeId}`, `REPORT#${identityHash}`, {
      PK: `MEME#${memeId}`,
      SK: `REPORT#${identityHash}`,
      reason: "spam",
      createdAt: new Date().toISOString(),
    });
  }

  const result = await getReportedMemeIds(identityHash, memeIds);

  assert.strictEqual(result.length, reportedIds.length);
  assert.deepStrictEqual([...result].sort(), [...reportedIds].sort());
  assert.ok(state.batchCallCount >= 2, "expected more than one BatchGet call to be chunked");
  assert.ok(state.maxKeysPerCall <= 100, "no single BatchGet call should exceed 100 keys");
});

test("getReportedMemeIds returns [] without calling DynamoDB for an empty id list", async () => {
  const { getReportedMemeIds } = await load("lib/db.ts");
  const { state, resetStub } = await loadStub();
  resetStub();

  const result = await getReportedMemeIds("identity-abc", []);

  assert.deepStrictEqual(result, []);
  assert.strictEqual(state.batchCallCount, 0);
});
