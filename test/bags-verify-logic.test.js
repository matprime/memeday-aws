const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// Fixed fake values so this file doesn't depend on whatever real BAGS_API_KEY
// happens to be in .env locally. Set before the .env loader below so its
// "only set if undefined" guard leaves these alone.
process.env.BAGS_API_KEY = "test-api-key";
// Real, decodable (but obviously fake) 32-byte pubkeys — the account read
// below round-trips these through PublicKey, unlike the old accountKeys
// string-equality check, so they must actually decode.
process.env.BAGS_PARTNER_WALLET = "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2";
process.env.BAGS_PARTNER_CONFIG = "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3";

// lib/bags-server.ts now imports lib/solana/network.ts (for the live/mock
// gate, KAN-29 follow-up correction 1), which validates SOLANA_NETWORK/
// SOLANA_RPC_URL/SOLANA_ENABLED at import — same env loading as the other
// integration tests so that import doesn't throw here. .env.local's devnet
// config means isBagsLiveModeEnabled() is false for every test in this file;
// see test/bags-live-mode.test.js for the mainnet/live=true scenario, which
// needs its own process to safely set different SOLANA_* values.
for (const envFile of [".env.local", ".env"]) {
  const envPath = path.join(__dirname, "..", envFile);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  }
}

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

const MODULE_PATH = path.join(__dirname, "..", "lib", "bags-server.ts");
function load() {
  return import(pathToFileURL(MODULE_PATH).href);
}

// ── isBagsLiveModeEnabled: devnet in this process's env ─────────────────────

test("isBagsLiveModeEnabled: false under this test env's devnet config", async () => {
  const { isBagsLiveModeEnabled } = await load();
  assert.strictEqual(isBagsLiveModeEnabled(), false);
});

// ── getPartnerAttribution: on-chain FeeShareConfig read ─────────────────────

const { Connection, PublicKey } = require("@solana/web3.js");

const FEE_SHARE_V2_PROGRAM_ID = "FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK";
const MATCHING_DISCRIMINATOR = [40, 71, 136, 156, 222, 49, 31, 201];
const WRONG_DISCRIMINATOR = [1, 2, 3, 4, 5, 6, 7, 8];

// Builds a FeeShareConfig account's raw bytes from the layout in the ticket:
// discriminator(8) base_mint(32) quote_mint(32) partner(32) partner_config(32).
// Exercises the byte offsets the implementation reads, not just the branch.
function buildFeeShareConfigData({ discriminator, partner, partnerConfig }) {
  const data = Buffer.alloc(136);
  Buffer.from(discriminator).copy(data, 0);
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

test("getPartnerAttribution: attributed when owner, discriminator and both keys match", async () => {
  const { getPartnerAttribution } = await load();
  await withMockedAccountInfo(
    async () => ({
      owner: new PublicKey(FEE_SHARE_V2_PROGRAM_ID),
      data: buildFeeShareConfigData({
        discriminator: MATCHING_DISCRIMINATOR,
        partner: process.env.BAGS_PARTNER_WALLET,
        partnerConfig: process.env.BAGS_PARTNER_CONFIG,
      }),
      lamports: 1,
      executable: false,
      rentEpoch: 0,
    }),
    async () => {
      const result = await getPartnerAttribution("BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS");
      assert.strictEqual(result, "attributed");
    }
  );
});

test("getPartnerAttribution: not_attributed when the account is valid but names a different partner", async () => {
  const { getPartnerAttribution } = await load();
  await withMockedAccountInfo(
    async () => ({
      owner: new PublicKey(FEE_SHARE_V2_PROGRAM_ID),
      data: buildFeeShareConfigData({
        discriminator: MATCHING_DISCRIMINATOR,
        partner: "4Ss5JMkXAD9Z7cktFEdrqeMuT6jGMF1pVozTyPHZ6zT4",
        partnerConfig: process.env.BAGS_PARTNER_CONFIG,
      }),
      lamports: 1,
      executable: false,
      rentEpoch: 0,
    }),
    async () => {
      const result = await getPartnerAttribution("BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS");
      assert.strictEqual(result, "not_attributed");
    }
  );
});

test("getPartnerAttribution: unknown when the account does not exist", async () => {
  const { getPartnerAttribution } = await load();
  await withMockedAccountInfo(
    async () => null,
    async () => {
      const result = await getPartnerAttribution("BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS");
      assert.strictEqual(result, "unknown");
    }
  );
});

test("getPartnerAttribution: unknown on a wrong discriminator", async () => {
  const { getPartnerAttribution } = await load();
  await withMockedAccountInfo(
    async () => ({
      owner: new PublicKey(FEE_SHARE_V2_PROGRAM_ID),
      data: buildFeeShareConfigData({
        discriminator: WRONG_DISCRIMINATOR,
        partner: process.env.BAGS_PARTNER_WALLET,
        partnerConfig: process.env.BAGS_PARTNER_CONFIG,
      }),
      lamports: 1,
      executable: false,
      rentEpoch: 0,
    }),
    async () => {
      const result = await getPartnerAttribution("BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS");
      assert.strictEqual(result, "unknown");
    }
  );
});

test("getPartnerAttribution: unknown when the RPC call throws", async () => {
  const { getPartnerAttribution } = await load();
  await withMockedAccountInfo(
    async () => {
      throw new Error("RPC unavailable");
    },
    async () => {
      const result = await getPartnerAttribution("BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS");
      assert.strictEqual(result, "unknown");
    }
  );
});

// ── isCallerVerifiedCreator: creator/v3 match ───────────────────────────────

test("isCallerVerifiedCreator: true on a wallet match with isCreator true", async () => {
  const { isCallerVerifiedCreator } = await load();
  const creators = [
    { wallet: "SomeoneElse111111111111111111111111111111", isCreator: false },
    { wallet: "CallerWallet1111111111111111111111111111", isCreator: true },
  ];
  assert.strictEqual(isCallerVerifiedCreator(creators, "CallerWallet1111111111111111111111111111"), true);
});

test("isCallerVerifiedCreator: false when the wallet isn't in the list (mismatch)", async () => {
  const { isCallerVerifiedCreator } = await load();
  const creators = [{ wallet: "SomeoneElse111111111111111111111111111111", isCreator: true }];
  assert.strictEqual(isCallerVerifiedCreator(creators, "CallerWallet1111111111111111111111111111"), false);
});

test("isCallerVerifiedCreator: false when the wallet matches but isCreator is false", async () => {
  const { isCallerVerifiedCreator } = await load();
  const creators = [{ wallet: "CallerWallet1111111111111111111111111111", isCreator: false }];
  assert.strictEqual(isCallerVerifiedCreator(creators, "CallerWallet1111111111111111111111111111"), false);
});

test("isCallerVerifiedCreator: false on an empty creator list", async () => {
  const { isCallerVerifiedCreator } = await load();
  assert.strictEqual(isCallerVerifiedCreator([], "CallerWallet1111111111111111111111111111"), false);
});

// ── getTokenLaunch / getTokenCreators: fetch mocked, no live network calls ──

function withMockedFetch(response, fn) {
  const originalFetch = global.fetch;
  let capturedUrl;
  let capturedInit;
  let callCount = 0;
  global.fetch = async (url, init) => {
    callCount += 1;
    capturedUrl = url;
    capturedInit = init;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
    };
  };
  return Promise.resolve()
    .then(() => fn(() => ({ url: capturedUrl, init: capturedInit, callCount })))
    .finally(() => {
      global.fetch = originalFetch;
    });
}

test("getTokenLaunch: sends the x-api-key header and parses a full response", async () => {
  const { getTokenLaunch } = await load();
  await withMockedFetch(
    {
      body: {
        success: true,
        response: { status: "live", launchWallet: "w", creatorFeeBps: 10000, dbcConfigKey: "c", dbcPoolKey: "p" },
      },
    },
    async (getCapture) => {
      const launch = await getTokenLaunch("BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS");
      assert.deepStrictEqual(launch, {
        status: "live",
        launchWallet: "w",
        creatorFeeBps: 10000,
        dbcConfigKey: "c",
        dbcPoolKey: "p",
      });
      const { url, init } = getCapture();
      assert.match(url, /^https:\/\/public-api-v2\.bags\.fm\/api\/v1\/token-launch\?tokenMint=/);
      assert.strictEqual(init.headers["x-api-key"], "test-api-key");
    }
  );
});

test("getTokenLaunch: missing optional fields come back undefined, not thrown", async () => {
  const { getTokenLaunch } = await load();
  await withMockedFetch({ body: { success: true, response: {} } }, async () => {
    const launch = await getTokenLaunch("mint");
    assert.strictEqual(launch.status, undefined);
    assert.strictEqual(launch.launchWallet, undefined);
  });
});

test("getTokenCreators: parses an array of creator rows", async () => {
  const { getTokenCreators } = await load();
  await withMockedFetch(
    {
      body: {
        success: true,
        response: [{ wallet: "w1", royaltyBps: 10000, isCreator: true, isAdmin: false, provider: "twitter", providerUsername: "u" }],
      },
    },
    async (getCapture) => {
      const creators = await getTokenCreators("mint");
      assert.strictEqual(creators.length, 1);
      assert.strictEqual(creators[0].wallet, "w1");
      assert.strictEqual(creators[0].isCreator, true);
      const { url } = getCapture();
      assert.match(url, /\/token-launch\/creator\/v3\?tokenMint=/);
    }
  );
});

test("getTokenCreators: a missing or non-array response field comes back as an empty array, not a throw", async () => {
  const { getTokenCreators } = await load();
  await withMockedFetch({ body: { success: false, error: "not found" } }, async () => {
    const creators = await getTokenCreators("mint");
    assert.deepStrictEqual(creators, []);
  });
});

test("getTokenLaunch: a non-OK response throws instead of returning a fake launch", async () => {
  const { getTokenLaunch } = await load();
  await withMockedFetch({ ok: false, status: 500, body: {} }, async () => {
    await assert.rejects(() => getTokenLaunch("mint"));
  });
});

// ── verifyBagsLaunch: mock path (live gate false in this file's env) ───────

test("verifyBagsLaunch: simulated result when the live gate is false, no fetch to bags.fm", async () => {
  const { verifyBagsLaunch } = await load();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("should never be called in mock mode");
  };
  try {
    const result = await verifyBagsLaunch({ callerWallet: undefined, tokenMint: undefined, name: "My Token", symbol: "MLRD" });
    assert.strictEqual(result.simulated, true);
    assert.strictEqual(result.partnerAttribution, "attributed");
    assert.match(result.tokenMint, /^SIMULATED_MLRD$/);
    assert.strictEqual(calls, 0, "no network call should be made in mock mode");
  } finally {
    global.fetch = originalFetch;
  }
});

test("verifyBagsLaunch: simulated result needs no tokenMint or linked wallet", async () => {
  const { verifyBagsLaunch } = await load();
  // Should not throw even though a live call would require both.
  const result = await verifyBagsLaunch({ name: "My Token", symbol: "MLRD" });
  assert.strictEqual(result.simulated, true);
});
