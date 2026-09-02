const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// lib/bags.ts is a "use client" file with a relative extensionless import
// (./types) that only bundler-aware tooling resolves — same hook as the other
// lib/*.ts unit tests (see test/rate-limit.test.js).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

function load() {
  return import(pathToFileURL(path.join(__dirname, "..", "lib", "bags.ts")).href);
}

const PARTNER = { partner: "2dZD7eSRA1Xnoox75cZurHBV5casHKewSESVCH69PV8h", partnerConfig: "98CU6K5sWVXrDorwMt4jm3gezbu9LKys2Ycm5un59m1A" };

test("buildBagsLaunchIntentUrl: builds the expected params for a normal launch", async () => {
  const { buildBagsLaunchIntentUrl } = await load();
  const url = buildBagsLaunchIntentUrl({
    name: "My Meme Token",
    ticker: "mlrd",
    description: "a token",
    image: "https://cdn.example/img.png",
    ...PARTNER,
  });

  assert.match(url, /^https:\/\/bags\.fm\/launch\?intent=true&/);
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get("name"), "My Meme Token");
  assert.strictEqual(params.get("ticker"), "MLRD", "ticker is uppercased");
  assert.strictEqual(params.get("description"), "a token");
  assert.strictEqual(params.get("image"), "https://cdn.example/img.png");
  assert.strictEqual(params.get("partner"), PARTNER.partner);
  assert.strictEqual(params.get("partnerConfig"), PARTNER.partnerConfig);
});

test("buildBagsLaunchIntentUrl: never sends feeMode", async () => {
  const { buildBagsLaunchIntentUrl } = await load();
  const url = buildBagsLaunchIntentUrl({ name: "Token", ticker: "TKN", ...PARTNER });
  assert.doesNotMatch(url, /feeMode/i);
});

test("buildBagsLaunchIntentUrl: enforces the name length limit by truncating", async () => {
  const { buildBagsLaunchIntentUrl } = await load();
  const longName = "x".repeat(50);
  const url = buildBagsLaunchIntentUrl({ name: longName, ticker: "TKN", ...PARTNER });
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get("name")?.length, 32);
});

test("buildBagsLaunchIntentUrl: enforces the ticker length/character limits", async () => {
  const { buildBagsLaunchIntentUrl } = await load();
  const url = buildBagsLaunchIntentUrl({ name: "Token", ticker: "  mlrd-coin!! ", ...PARTNER });
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get("ticker"), "MLRDCOIN", "non-alphanumeric chars stripped, capped at 10");
});

test("buildBagsLaunchIntentUrl: refuses to build when partner is missing", async () => {
  const { buildBagsLaunchIntentUrl, BagsLaunchConfigError } = await load();
  assert.throws(
    () => buildBagsLaunchIntentUrl({ name: "Token", ticker: "TKN", partnerConfig: PARTNER.partnerConfig }),
    BagsLaunchConfigError
  );
});

test("buildBagsLaunchIntentUrl: refuses to build when partnerConfig is missing", async () => {
  const { buildBagsLaunchIntentUrl, BagsLaunchConfigError } = await load();
  assert.throws(
    () => buildBagsLaunchIntentUrl({ name: "Token", ticker: "TKN", partner: PARTNER.partner }),
    BagsLaunchConfigError
  );
});

test("buildBagsLaunchIntentUrl: refuses to build when both partner and partnerConfig are missing", async () => {
  const { buildBagsLaunchIntentUrl, BagsLaunchConfigError } = await load();
  assert.throws(() => buildBagsLaunchIntentUrl({ name: "Token", ticker: "TKN" }), BagsLaunchConfigError);
});

test("buildBagsLaunchIntentUrl: refuses a ticker that is all non-alphanumeric junk", async () => {
  const { buildBagsLaunchIntentUrl, BagsLaunchConfigError } = await load();
  assert.throws(() => buildBagsLaunchIntentUrl({ name: "Token", ticker: "!!!", ...PARTNER }), BagsLaunchConfigError);
});

test("isPlausibleSolanaAddress: accepts a well-formed base58 address", async () => {
  const { isPlausibleSolanaAddress } = await load();
  assert.strictEqual(isPlausibleSolanaAddress("BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS"), true);
});

test("isPlausibleSolanaAddress: rejects obviously-invalid input", async () => {
  const { isPlausibleSolanaAddress } = await load();
  assert.strictEqual(isPlausibleSolanaAddress("not-an-address"), false);
  assert.strictEqual(isPlausibleSolanaAddress("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"), false, "0/O/I/l are not base58");
  assert.strictEqual(isPlausibleSolanaAddress("short"), false);
  assert.strictEqual(isPlausibleSolanaAddress(""), false);
});
