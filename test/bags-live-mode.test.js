const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// The mainnet/live=true scenario for the KAN-29 follow-up's single switch
// (lib/bags-server.ts isBagsLiveModeEnabled). Deliberately synthetic env, not
// .env/.env.local (which are devnet) — `node --test` runs each file in its
// own process, so setting these here doesn't affect any other test file.
process.env.SOLANA_NETWORK = "mainnet";
process.env.SOLANA_ENABLED = "true";
process.env.VERCEL_ENV = "production";
process.env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
process.env.BAGS_API_KEY = "test-live-api-key";
process.env.BAGS_PARTNER_WALLET = "PARTNERWALLET11111111111111111111111111111";
process.env.BAGS_PARTNER_CONFIG = "PARTNERCONFIG1111111111111111111111111111";

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

test("isBagsLiveModeEnabled: true on mainnet + SOLANA_ENABLED=true", async () => {
  const { isBagsLiveModeEnabled } = await load();
  assert.strictEqual(isBagsLiveModeEnabled(), true);
});

test("verifyBagsLaunch: live gate true calls the real client (fetch mocked, no live network call)", async () => {
  const { verifyBagsLaunch } = await load();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    if (String(url).includes("/creator/v3")) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ wallet: "CallerWallet1111111111111111111111111111", isCreator: true }],
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ accountKeys: ["a", process.env.BAGS_PARTNER_WALLET] }),
    };
  };
  try {
    const result = await verifyBagsLaunch({
      callerWallet: "CallerWallet1111111111111111111111111111",
      tokenMint: "BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS",
      name: "My Token",
      symbol: "MLRD",
    });
    assert.strictEqual(result.simulated, false);
    assert.strictEqual(result.partnerAttributed, true);
    assert.strictEqual(result.tokenMint, "BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS");
    assert.strictEqual(calls, 2, "expected one call each to creator/v3 and token-launch");
  } finally {
    global.fetch = originalFetch;
  }
});

test("verifyBagsLaunch: live gate true rejects a missing tokenMint before calling Bags", async () => {
  const { verifyBagsLaunch, BagsVerifyError } = await load();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("should not be called");
  };
  try {
    await assert.rejects(
      () => verifyBagsLaunch({ callerWallet: "SomeWallet", tokenMint: undefined, name: "n", symbol: "s" }),
      (err) => err instanceof BagsVerifyError && err.status === 400
    );
    assert.strictEqual(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("verifyBagsLaunch: live gate true rejects a creator mismatch with 403", async () => {
  const { verifyBagsLaunch, BagsVerifyError } = await load();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{ wallet: "SomeoneElse1111111111111111111111111111111", isCreator: true }],
  });
  try {
    await assert.rejects(
      () =>
        verifyBagsLaunch({
          callerWallet: "CallerWallet1111111111111111111111111111",
          tokenMint: "BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS",
          name: "n",
          symbol: "s",
        }),
      (err) => err instanceof BagsVerifyError && err.status === 403
    );
  } finally {
    global.fetch = originalFetch;
  }
});
