const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// scripts/cleanup-orphan-points.ts (KAN-67) only imports lib/points-config.ts
// with an explicit ".ts" extension (needed so the script also runs directly
// with plain `node`, not just under a test loader), so it needs none of
// batch-get-chunking.test.js's extension-guessing resolve hook -- a plain
// dynamic import is enough.
function load() {
  return import(
    pathToFileURL(path.join(__dirname, "..", "scripts", "cleanup-orphan-points.ts")).href
  );
}

test("assertRequiredTable rejects any table name other than MemeDayDev", async () => {
  const { assertRequiredTable, REQUIRED_TABLE } = await load();
  assert.strictEqual(REQUIRED_TABLE, "MemeDayDev");
  assert.doesNotThrow(() => assertRequiredTable("MemeDayDev"));
  for (const bad of ["MemeDayProd", "MemeDay", "memedaydev", ""]) {
    assert.throws(() => assertRequiredTable(bad));
  }
});

test("classifyUserId matches the id shapes seen across test/*.test.js and scripts/test-s3-upload-handler.sh", async () => {
  const { classifyUserId } = await load();
  // "test-..." (hyphens): scripts/test-s3-upload-handler.sh, test/pending-upload.test.js, etc.
  assert.strictEqual(classifyUserId("test-user-1700000000"), "test-pattern");
  assert.strictEqual(classifyUserId("test-browse-page-42"), "test-pattern");
  // "test_..." (underscores): test/points.test.js, test/stream-handler.test.js, etc.
  assert.strictEqual(classifyUserId("test_pts_replay_creator_1700000000"), "test-pattern");
  assert.strictEqual(classifyUserId("test_sh_creator_1700000000"), "test-pattern");
  // "someone-else-...": test/bags-token-binding.test.js, test/meme-listing.test.js
  assert.strictEqual(classifyUserId("someone-else-1700000000"), "test-pattern");
  // A real Cognito sub (UUID-shaped) matches none of the three test shapes.
  assert.strictEqual(classifyUserId("0275e444-1001-7050-a268-a0db9e047689"), "other");
  // Case sensitive on purpose: the actual prefixes are lowercase.
  assert.strictEqual(classifyUserId("Test-user-1"), "other");
});

test("partitionForApply skips a userId that now has a USER# item", async () => {
  const { partitionForApply } = await load();
  const deleteKeys = [
    { PK: "POINTS#test-user-1", SK: "AWARD#UPLOAD#meme-1", itemType: "AWARD#", userId: "test-user-1" },
    { PK: "LB#ALLTIME", SK: "USER#test-user-1", itemType: "LB#ALLTIME", userId: "test-user-1" },
    { PK: "LB#ALLTIME", SK: "USER#test-user-2", itemType: "LB#ALLTIME", userId: "test-user-2" },
  ];
  // test-user-2 signed up for real between the dry run and apply.
  const stillOrphan = new Set(["test-user-1"]);

  const { toDelete, skipped } = partitionForApply(deleteKeys, stillOrphan);

  assert.strictEqual(toDelete.length, 2);
  assert.ok(toDelete.every((k) => k.userId === "test-user-1"));
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].userId, "test-user-2");
});
