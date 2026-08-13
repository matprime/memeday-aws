const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODULE_PATH = path.join(__dirname, "..", "lib", "solana", "network.ts");

// Node caches ES modules by resolved URL. A cache-busting query string forces
// a fresh module instance per test case, so each set of env vars gets its own
// top-level (import-time) evaluation of network.ts.
let importCount = 0;
async function importNetworkModule() {
  importCount += 1;
  return import(`${pathToFileURL(MODULE_PATH).href}?case=${importCount}`);
}

const REQUIRED_BASE_ENV = {
  SOLANA_RPC_URL: "https://example-rpc.test",
  SOLANA_ENABLED: "true",
};

// Pass `null` for a key in `overrides` to delete it (rather than set it) —
// used to test a genuinely missing var instead of an empty string.
function withEnv(overrides, fn) {
  const keys = ["SOLANA_NETWORK", "SOLANA_RPC_URL", "SOLANA_ENABLED", "VERCEL_ENV"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  const merged = { ...REQUIRED_BASE_ENV, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

test("mainnet guard: VERCEL_ENV=production + SOLANA_NETWORK=mainnet is allowed", async () => {
  await withEnv({ SOLANA_NETWORK: "mainnet", VERCEL_ENV: "production" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_NETWORK, "mainnet");
    assert.strictEqual(mod.SOLANA_EXPLORER_CLUSTER, "mainnet-beta");
  });
});

test("mainnet guard: VERCEL_ENV=preview + SOLANA_NETWORK=mainnet is rejected", async () => {
  await withEnv({ SOLANA_NETWORK: "mainnet", VERCEL_ENV: "preview" }, async () => {
    await assert.rejects(() => importNetworkModule());
  });
});

test("mainnet guard: VERCEL_ENV unset + SOLANA_NETWORK=mainnet is rejected", async () => {
  await withEnv({ SOLANA_NETWORK: "mainnet" }, async () => {
    await assert.rejects(() => importNetworkModule());
  });
});

test("mainnet guard: VERCEL_ENV=production + SOLANA_NETWORK=devnet is allowed", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", VERCEL_ENV: "production" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_NETWORK, "devnet");
    assert.strictEqual(mod.SOLANA_EXPLORER_CLUSTER, "devnet");
  });
});

test("mainnet guard: devnet is allowed with VERCEL_ENV unset (local/CI)", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_NETWORK, "devnet");
  });
});

test("test matrix: devnet works on Preview (VERCEL_ENV=preview + SOLANA_NETWORK=devnet)", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", VERCEL_ENV: "preview" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_NETWORK, "devnet");
  });
});

test("loud fail: missing SOLANA_NETWORK throws at import", async () => {
  await withEnv({}, async () => {
    await assert.rejects(() => importNetworkModule());
  });
});

test("loud fail: invalid SOLANA_NETWORK throws at import", async () => {
  await withEnv({ SOLANA_NETWORK: "testnet" }, async () => {
    await assert.rejects(() => importNetworkModule());
  });
});

test("loud fail: missing SOLANA_RPC_URL throws at import", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: null }, async () => {
    await assert.rejects(() => importNetworkModule());
  });
});

test("kill switch: SOLANA_ENABLED=false is explicit and checkable", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "false" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_ENABLED, false);
    assert.strictEqual(typeof mod.SOLANA_DISABLED_MESSAGE, "string");
    assert.ok(mod.SOLANA_DISABLED_MESSAGE.length > 0);
  });
});

test("kill switch: SOLANA_ENABLED=true enables on-chain actions", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "true" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_ENABLED, true);
  });
});

test("loud fail: invalid SOLANA_ENABLED throws at import", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "yes" }, async () => {
    await assert.rejects(() => importNetworkModule());
  });
});

// The checks below pin the SOLANA_ENABLED/SOLANA_DISABLED_MESSAGE contract
// that each on-chain entry point reads via useSolanaConfig (WalletProvider.tsx,
// sourced from this module through app/layout.tsx). They don't render React —
// no jsdom/testing-library in this repo — so they can't click a button and
// assert on the resulting DOM. What they pin: the exact enabled/message pair
// each component's gating logic branches on, so a change here (e.g. someone
// renaming SOLANA_DISABLED_MESSAGE or flipping the boolean's meaning) fails
// loudly instead of silently breaking a kill switch three components rely on.

// InvestModal (Top Creators popup on the home page, and CreatorInvestButton
// on the creator page — both mount the same InvestModal): handleBuy/handleSell
// return early on `!enabled`, and the buy/sell form + action button are
// replaced with a banner showing `disabledMessage` (InvestModal.tsx).
test("kill switch: SOLANA_ENABLED=false — InvestModal reads enabled=false + disabledMessage", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "false" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_ENABLED, false);
    assert.strictEqual(
      mod.SOLANA_DISABLED_MESSAGE,
      "On-chain features are temporarily disabled. Please check back soon."
    );
  });
});

test("kill switch: SOLANA_ENABLED=true — InvestModal reads enabled=true, buy/sell allowed", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "true" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_ENABLED, true);
  });
});

// TipModal (Tip button on MemeCard): when !enabled, the tip form/QR code is
// replaced with a banner showing `disabledMessage` and the "Send Tip" button
// isn't rendered at all; handleSendTip also returns early on `!enabled` as a
// defense-in-depth guard (TipModal.tsx).
test("kill switch: SOLANA_ENABLED=false — TipModal reads enabled=false + disabledMessage", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "false" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_ENABLED, false);
    assert.strictEqual(
      mod.SOLANA_DISABLED_MESSAGE,
      "On-chain features are temporarily disabled. Please check back soon."
    );
  });
});

test("kill switch: SOLANA_ENABLED=true — TipModal reads enabled=true, Send Tip allowed", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "true" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_ENABLED, true);
  });
});

// PostMemeModal "Mint as NFT" toggle: clicking it while `!enabled && !isNFT`
// shows a toast with `disabledMessage` and leaves the toggle off instead of
// enabling NFT mode; handleSubmit has the same guard before calling
// mintMemeNft, so even a pre-toggled isNFT state can't mint while disabled
// (PostMemeModal.tsx lines ~132-134, ~288-292).
test("kill switch: SOLANA_ENABLED=false — PostMemeModal reads enabled=false + disabledMessage", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "false" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_ENABLED, false);
    assert.strictEqual(
      mod.SOLANA_DISABLED_MESSAGE,
      "On-chain features are temporarily disabled. Please check back soon."
    );
  });
});

test("kill switch: SOLANA_ENABLED=true — PostMemeModal reads enabled=true, minting allowed", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "true" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_ENABLED, true);
  });
});

// MemeCard "Invest in creator's token" button (shown under every meme,
// including on the creator page): onClick toasts a "coming soon" message when
// `enabled`, or `disabledMessage` when `!enabled` (MemeCard.tsx).
test("kill switch: SOLANA_ENABLED=false — MemeCard invest button shows disabledMessage, not \"coming soon\"", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "false" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_ENABLED, false);
    assert.strictEqual(
      mod.SOLANA_DISABLED_MESSAGE,
      "On-chain features are temporarily disabled. Please check back soon."
    );
  });
});

test("kill switch: SOLANA_ENABLED=true — MemeCard invest button shows \"coming soon\" toast", async () => {
  await withEnv({ SOLANA_NETWORK: "devnet", SOLANA_ENABLED: "true" }, async () => {
    const mod = await importNetworkModule();
    assert.strictEqual(mod.SOLANA_ENABLED, true);
  });
});
