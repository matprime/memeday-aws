const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function load() {
  return import(pathToFileURL(path.join(__dirname, "..", "lib", "bags-launch-draft.ts")).href);
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

function throwingStorage() {
  const boom = () => {
    throw new Error("storage blocked");
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

test("bagsLaunchDraftKey: keyed per memeId", async () => {
  const { bagsLaunchDraftKey } = await load();
  assert.strictEqual(bagsLaunchDraftKey("abc"), "memeday:bags-launch:abc");
  assert.notStrictEqual(bagsLaunchDraftKey("abc"), bagsLaunchDraftKey("def"));
});

test("draft: save then load round-trips all three fields", async () => {
  const { saveBagsLaunchDraft, loadBagsLaunchDraft } = await load();
  const draft = { name: "Mallard", ticker: "MLRD", description: "a duck" };
  saveBagsLaunchDraft("m1", draft);
  assert.deepStrictEqual(loadBagsLaunchDraft("m1"), draft);
});

test("draft: one meme's draft is not visible under another memeId", async () => {
  const { saveBagsLaunchDraft, loadBagsLaunchDraft } = await load();
  saveBagsLaunchDraft("m1", { name: "A", ticker: "AA", description: "" });
  assert.strictEqual(loadBagsLaunchDraft("m2"), null);
});

test("draft: load returns null when nothing is saved", async () => {
  const { loadBagsLaunchDraft } = await load();
  assert.strictEqual(loadBagsLaunchDraft("none"), null);
});

test("draft: clear removes the saved draft", async () => {
  const { saveBagsLaunchDraft, loadBagsLaunchDraft, clearBagsLaunchDraft } = await load();
  saveBagsLaunchDraft("m1", { name: "A", ticker: "AA", description: "d" });
  clearBagsLaunchDraft("m1");
  assert.strictEqual(loadBagsLaunchDraft("m1"), null);
});

test("draft: corrupt JSON or wrong-typed fields are ignored, not thrown", async () => {
  const { bagsLaunchDraftKey, loadBagsLaunchDraft } = await load();
  localStorage.setItem(bagsLaunchDraftKey("m1"), "{not json");
  assert.strictEqual(loadBagsLaunchDraft("m1"), null);
  localStorage.setItem(bagsLaunchDraftKey("m1"), JSON.stringify({ name: 5, ticker: "OK" }));
  assert.deepStrictEqual(loadBagsLaunchDraft("m1"), { ticker: "OK" });
});

test("draft: helpers do not throw when storage throws", async () => {
  const { saveBagsLaunchDraft, loadBagsLaunchDraft, clearBagsLaunchDraft } = await load();
  globalThis.localStorage = throwingStorage();
  assert.doesNotThrow(() => saveBagsLaunchDraft("m1", { name: "A", ticker: "AA", description: "" }));
  assert.strictEqual(loadBagsLaunchDraft("m1"), null);
  assert.doesNotThrow(() => clearBagsLaunchDraft("m1"));
});

test("draft: helpers do not throw when localStorage is absent", async () => {
  const { saveBagsLaunchDraft, loadBagsLaunchDraft, clearBagsLaunchDraft } = await load();
  delete globalThis.localStorage;
  assert.doesNotThrow(() => saveBagsLaunchDraft("m1", { name: "A", ticker: "AA", description: "" }));
  assert.strictEqual(loadBagsLaunchDraft("m1"), null);
  assert.doesNotThrow(() => clearBagsLaunchDraft("m1"));
});

test("BAGS_LAUNCH_MIN_SOL is 0.05", async () => {
  const { BAGS_LAUNCH_MIN_SOL } = await load();
  assert.strictEqual(BAGS_LAUNCH_MIN_SOL, 0.05);
});

test("isBelowBagsLaunchMin: below warns, equal and above do not", async () => {
  const { isBelowBagsLaunchMin } = await load();
  assert.strictEqual(isBelowBagsLaunchMin(49_999_999), true);
  assert.strictEqual(isBelowBagsLaunchMin(0), true);
  assert.strictEqual(isBelowBagsLaunchMin(50_000_000), false);
  assert.strictEqual(isBelowBagsLaunchMin(50_000_001), false);
});
