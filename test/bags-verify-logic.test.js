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
process.env.BAGS_PARTNER_WALLET = "PARTNERWALLET11111111111111111111111111111";
process.env.BAGS_PARTNER_CONFIG = "PARTNERCONFIG1111111111111111111111111111";

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

// ── isPartnerAttributed: accountKeys check ──────────────────────────────────

test("isPartnerAttributed: true when accountKeys contains our partner wallet", async () => {
  const { isPartnerAttributed } = await load();
  assert.strictEqual(
    isPartnerAttributed({ accountKeys: ["someOtherKey", process.env.BAGS_PARTNER_WALLET] }),
    true
  );
});

test("isPartnerAttributed: false when accountKeys is null", async () => {
  const { isPartnerAttributed } = await load();
  assert.strictEqual(isPartnerAttributed({ accountKeys: null }), false);
});

test("isPartnerAttributed: false when accountKeys is present but does not contain our wallet", async () => {
  const { isPartnerAttributed } = await load();
  assert.strictEqual(isPartnerAttributed({ accountKeys: ["someOtherKey", "anotherKey"] }), false);
});

test("isPartnerAttributed: false on an empty accountKeys array", async () => {
  const { isPartnerAttributed } = await load();
  assert.strictEqual(isPartnerAttributed({ accountKeys: [] }), false);
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
    { body: { accountKeys: ["a", "b"], status: "live", launchWallet: "w", creatorFeeBps: 10000, dbcConfigKey: "c", dbcPoolKey: "p" } },
    async (getCapture) => {
      const launch = await getTokenLaunch("BmAGtXaTo5svvDLHLDJHpFJhhPuAbmNvBg1yFh7JBAGS");
      assert.deepStrictEqual(launch, {
        accountKeys: ["a", "b"],
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

test("getTokenLaunch: treats a null accountKeys as null, not an empty array", async () => {
  const { getTokenLaunch } = await load();
  await withMockedFetch({ body: { accountKeys: null } }, async () => {
    const launch = await getTokenLaunch("mint");
    assert.strictEqual(launch.accountKeys, null);
  });
});

test("getTokenLaunch: missing optional fields come back undefined, not thrown", async () => {
  const { getTokenLaunch } = await load();
  await withMockedFetch({ body: { accountKeys: [] } }, async () => {
    const launch = await getTokenLaunch("mint");
    assert.strictEqual(launch.status, undefined);
    assert.strictEqual(launch.launchWallet, undefined);
  });
});

test("getTokenCreators: parses an array of creator rows", async () => {
  const { getTokenCreators } = await load();
  await withMockedFetch(
    { body: [{ wallet: "w1", royaltyBps: 10000, isCreator: true, isAdmin: false, provider: "twitter", providerUsername: "u" }] },
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

test("getTokenCreators: a non-array response comes back as an empty array, not a throw", async () => {
  const { getTokenCreators } = await load();
  await withMockedFetch({ body: { error: "not found" } }, async () => {
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
    assert.strictEqual(result.partnerAttributed, true);
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
