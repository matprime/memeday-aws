const { test } = require("node:test");
const assert = require("node:assert");

test("smoke: test runner is wired", () => {
  assert.strictEqual(1 + 1, 2);
});
