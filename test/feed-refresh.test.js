const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function load() {
  return import(pathToFileURL(path.join(__dirname, "..", "lib", "feed-refresh.ts")).href);
}

test("FEED_REFRESH_DELAYS_MS: ascending", async () => {
  const { FEED_REFRESH_DELAYS_MS } = await load();
  for (let i = 1; i < FEED_REFRESH_DELAYS_MS.length; i++) {
    assert.ok(FEED_REFRESH_DELAYS_MS[i] > FEED_REFRESH_DELAYS_MS[i - 1]);
  }
});

test("FEED_REFRESH_DELAYS_MS: positive", async () => {
  const { FEED_REFRESH_DELAYS_MS } = await load();
  for (const delay of FEED_REFRESH_DELAYS_MS) {
    assert.ok(delay > 0);
  }
});

test("FEED_REFRESH_DELAYS_MS: last delay is at most 10000ms", async () => {
  const { FEED_REFRESH_DELAYS_MS } = await load();
  assert.ok(FEED_REFRESH_DELAYS_MS[FEED_REFRESH_DELAYS_MS.length - 1] <= 10000);
});
