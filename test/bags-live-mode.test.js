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
// Real, decodable (but obviously fake) 32-byte pubkeys — the account read
// below round-trips these through PublicKey, unlike the old accountKeys
// string-equality check, so they must actually decode.
process.env.BAGS_PARTNER_WALLET = "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2";
process.env.BAGS_PARTNER_CONFIG = "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3";

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

const { Connection, PublicKey } = require("@solana/web3.js");
const FEE_SHARE_V2_PROGRAM_ID = "FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK";
const FEE_SHARE_CONFIG_DISCRIMINATOR = [40, 71, 136, 156, 222, 49, 31, 201];

// Builds a FeeShareConfig account's raw bytes: discriminator(8) base_mint(32)
// quote_mint(32) partner(32) partner_config(32). getPartnerAttribution reads
// this over RPC (Connection.getAccountInfo), not over the Bags HTTP API, so
// it's mocked at that layer rather than through global.fetch.
function buildFeeShareConfigData(partner, partnerConfig) {
  const data = Buffer.alloc(136);
  Buffer.from(FEE_SHARE_CONFIG_DISCRIMINATOR).copy(data, 0);
  new PublicKey(partner).toBuffer().copy(data, 72);
  new PublicKey(partnerConfig).toBuffer().copy(data, 104);
  return data;
}

function withMockedAccountInfo(getAccountInfoImpl, fn) {
  const original = Connection.prototype.getAccountInfo;
  Connection.prototype.getAccountInfo = getAccountInfoImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Connection.prototype.getAccountInfo = original;
    });
}

test("isBagsLiveModeEnabled: true on mainnet + SOLANA_ENABLED=true", async () => {
  const { isBagsLiveModeEnabled } = await load();
  assert.strictEqual(isBagsLiveModeEnabled(), true);
});

test("verifyBagsLaunch: live gate true calls the real client (fetch and on-chain read both mocked, no live network call)", async () => {
  const { verifyBagsLaunch } = await load();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    if (String(url).includes("/creator/v3")) {
      return {
        ok: true,
        status: 200,
        // Bags wraps every response as { success, response } (confirmed
        // against the live API, KAN-82) — not a bare array.
        json: async () => ({
          success: true,
          response: [{ wallet: "CallerWallet1111111111111111111111111111", isCreator: true }],
        }),
      };
    }
    throw new Error(`unexpected fetch to ${url}: attribution is read on-chain, not via HTTP`);
  };
  try {
    await withMockedAccountInfo(
      async () => ({
        owner: new PublicKey(FEE_SHARE_V2_PROGRAM_ID),
        data: buildFeeShareConfigData(process.env.BAGS_PARTNER_WALLET, process.env.BAGS_PARTNER_CONFIG),
        lamports: 1,
        executable: false,
        rentEpoch: 0,
      }),
      async () => {
        const result = await verifyBagsLaunch({
          callerWallet: "CallerWallet1111111111111111111111111111",
          tokenMint: "BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS",
          name: "My Token",
          symbol: "MLRD",
        });
        assert.strictEqual(result.simulated, false);
        assert.strictEqual(result.partnerAttribution, "attributed");
        assert.strictEqual(result.tokenMint, "BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS");
        assert.strictEqual(calls, 1, "expected exactly one HTTP call, to creator/v3");
      }
    );
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
    // Real envelope (KAN-82) with a genuinely different wallet than the
    // caller — this must reject on the mismatch itself, not because the
    // response was silently unparsed.
    json: async () => ({
      success: true,
      response: [{ wallet: "SomeoneElse1111111111111111111111111111111", isCreator: true }],
    }),
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

// Regression test for KAN-82: before the fix, getTokenCreators treated the
// raw fetch body as the payload itself. A response that is NOT wrapped in
// { success, response } (the old, wrong assumption) must not be silently
// misread as a valid empty list that happens to match — it must genuinely
// find no creators and reject, the same as any other non-matching response.
test("verifyBagsLaunch: an unwrapped (legacy-shaped) creators response still rejects with 403, not a silent pass", async () => {
  const { verifyBagsLaunch, BagsVerifyError } = await load();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/creator/v3")) {
      return {
        ok: true,
        status: 200,
        // Bare array, not wrapped — this is the shape the pre-KAN-82 code
        // incorrectly expected. getTokenCreators must not find this array
        // by accident; Array.isArray(raw) is false here since raw itself
        // is the wrapper-shaped object once real parsing is in place, so
        // this must resolve to no creators found, i.e. still a 403.
        json: async () => [{ wallet: "CallerWallet1111111111111111111111111111", isCreator: true }],
      };
    }
    throw new Error(`unexpected fetch to ${url}: the creator mismatch must reject before attribution is read`);
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
      (err) => err instanceof BagsVerifyError && err.status === 403
    );
  } finally {
    global.fetch = originalFetch;
  }
});
