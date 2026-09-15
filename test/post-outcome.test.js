const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function load() {
  return import(pathToFileURL(path.join(__dirname, "..", "lib", "post-outcome.ts")).href);
}

test("postOutcome: a plain post reports success", async () => {
  const { postOutcome } = await load();
  const outcome = postOutcome({ caption: "Elon is a memelord", isNFT: false, minted: false });
  assert.strictEqual(outcome.tone, "success");
  assert.match(outcome.message, /^Meme posted! "Elon is a memelord…"$/);
});

test("postOutcome: a minted NFT reports success", async () => {
  const { postOutcome } = await load();
  const outcome = postOutcome({ caption: "Elon is a memelord", isNFT: true, minted: true });
  assert.strictEqual(outcome.tone, "success");
  assert.match(outcome.message, /^Meme posted!/);
});

// The KAN-11 regression: cancelling the wallet prompt used to report a plain
// "Meme posted!", which told the user an NFT existed when it did not.
test("postOutcome: an NFT that was asked for and not minted is not a plain success", async () => {
  const { postOutcome } = await load();
  const outcome = postOutcome({ caption: "Elon is a memelord", isNFT: true, minted: false });
  assert.strictEqual(outcome.tone, "warning");
  assert.match(outcome.message, /NFT wasn't minted/);
  assert.doesNotMatch(outcome.message, /^Meme posted! /);
});

test("postOutcome: the caption is truncated to 30 characters", async () => {
  const { postOutcome } = await load();
  const outcome = postOutcome({ caption: "x".repeat(50), isNFT: false, minted: false });
  assert.strictEqual(outcome.message, `Meme posted! "${"x".repeat(30)}…"`);
});
