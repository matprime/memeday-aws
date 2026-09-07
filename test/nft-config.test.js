const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODULE_PATH = path.join(__dirname, "..", "lib", "nft-config.ts");

// Same cache-busting trick as test/solana-network.test.js: nft-config.ts
// validates at import time, so each case needs its own module instance.
let importCount = 0;
async function importConfig() {
  importCount += 1;
  return import(`${pathToFileURL(MODULE_PATH).href}?case=${importCount}`);
}

const KEYS = [
  "SOLANA_COMMITMENT",
  "NFT_STORAGE_PROVIDER",
  "NFT_SECONDARY_SALE_ROYALTY_BASIS_POINTS",
  "NFT_ORPHANED_UPLOAD_RETENTION_HOURS",
];

// Pass `null` to delete a key rather than set it.
function withEnv(overrides, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

test("defaults apply when nothing is set", async () => {
  await withEnv({}, async () => {
    const mod = await importConfig();
    assert.strictEqual(mod.SOLANA_COMMITMENT, "confirmed");
    assert.strictEqual(mod.NFT_STORAGE_PROVIDER, "s3");
    assert.strictEqual(mod.NFT_ROYALTY_BASIS_POINTS, 250);
    assert.strictEqual(mod.NFT_ORPHANED_UPLOAD_RETENTION_HOURS, 24);
    assert.strictEqual(mod.NFT_ORPHANED_UPLOAD_RETENTION_SECONDS, 86400);
  });
});

test("valid overrides are accepted", async () => {
  await withEnv(
    {
      SOLANA_COMMITMENT: "finalized",
      NFT_STORAGE_PROVIDER: "irys",
      NFT_SECONDARY_SALE_ROYALTY_BASIS_POINTS: "500",
      NFT_ORPHANED_UPLOAD_RETENTION_HOURS: "48",
    },
    async () => {
      const mod = await importConfig();
      assert.strictEqual(mod.SOLANA_COMMITMENT, "finalized");
      assert.strictEqual(mod.NFT_STORAGE_PROVIDER, "irys");
      assert.strictEqual(mod.NFT_ROYALTY_BASIS_POINTS, 500);
      assert.strictEqual(mod.NFT_ORPHANED_UPLOAD_RETENTION_SECONDS, 48 * 3600);
    }
  );
});

test("invalid commitment is rejected", async () => {
  await withEnv({ SOLANA_COMMITMENT: "eventually" }, async () => {
    await assert.rejects(importConfig(), /Invalid SOLANA_COMMITMENT/);
  });
});

test("invalid storage provider is rejected", async () => {
  await withEnv({ NFT_STORAGE_PROVIDER: "ipfs" }, async () => {
    await assert.rejects(importConfig(), /Invalid NFT_STORAGE_PROVIDER/);
  });
});

test("royalty above 100% is rejected", async () => {
  await withEnv({ NFT_SECONDARY_SALE_ROYALTY_BASIS_POINTS: "10001" }, async () => {
    await assert.rejects(importConfig(), /Must be 0-10000/);
  });
});

// Number() would accept all of these and silently mean something else.
for (const bad of ["2.5", "1e3", " 250", "0x10", "-1", "abc"]) {
  test(`non-integer royalty "${bad}" is rejected`, async () => {
    await withEnv({ NFT_SECONDARY_SALE_ROYALTY_BASIS_POINTS: bad }, async () => {
      await assert.rejects(importConfig(), /Must be a whole number/);
    });
  });
}

test("zero retention is rejected — it would expire a request mid-signature", async () => {
  await withEnv({ NFT_ORPHANED_UPLOAD_RETENTION_HOURS: "0" }, async () => {
    await assert.rejects(importConfig(), /zero retention/);
  });
});

test("nonce TTL is shorter than a blockhash lifetime", async () => {
  await withEnv({}, async () => {
    const mod = await importConfig();
    assert.ok(mod.MINT_NONCE_TTL_SECONDS > 0);
    assert.ok(
      mod.MINT_NONCE_TTL_SECONDS <= 90,
      "nonce must expire before the blockhash so we produce the clear error, not the RPC"
    );
  });
});
