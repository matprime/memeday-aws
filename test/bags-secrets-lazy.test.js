const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// KAN-29 follow-up correction 2: BAGS_API_KEY/BAGS_PARTNER_WALLET/
// BAGS_PARTNER_CONFIG must be validated lazily, only when the live gate is
// true, naming the missing variable — not at import (that broke Preview,
// where they're deliberately unset). Own process (separate file) so setting
// mainnet here can't affect any other test file.
process.env.SOLANA_NETWORK = "mainnet";
process.env.SOLANA_ENABLED = "true";
process.env.VERCEL_ENV = "production";
process.env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
delete process.env.BAGS_API_KEY;
delete process.env.BAGS_PARTNER_WALLET;
delete process.env.BAGS_PARTNER_CONFIG;

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
  return import(pathToFileURL(path.join(__dirname, "..", "lib", "bags-server.ts")).href);
}

test("importing lib/bags-server.ts does not throw even with every BAGS_* var unset", async () => {
  // The assertion is just that this resolves at all — correction 2's whole
  // point is that Preview (which never sets these) must be able to import
  // this module and render the mock launch UI.
  await load();
});

test("getTokenLaunch: throws naming the missing variable once the live gate needs it", async () => {
  const { getTokenLaunch } = await load();
  await assert.rejects(() => getTokenLaunch("mint"), /BAGS_API_KEY/);
});

test("verifyBagsLaunch: live gate true + a valid mint still surfaces the missing-secret error, not a fetch call", async () => {
  const { verifyBagsLaunch } = await load();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("should not be reached — secrets check happens first");
  };
  try {
    await assert.rejects(
      () =>
        verifyBagsLaunch({
          callerWallet: "CallerWallet1111111111111111111111111111",
          tokenMint: "BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS",
          name: "n",
          symbol: "s",
        }),
      /BAGS_API_KEY/
    );
  } finally {
    global.fetch = originalFetch;
    assert.strictEqual(calls, 0);
  }
});
