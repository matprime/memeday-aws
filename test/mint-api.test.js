const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

for (const envFile of [".env.local", ".env"]) {
  const envPath = path.join(__dirname, "..", envFile);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  }
}
// The routes short-circuit to 503 when on-chain is switched off, which would
// mask the auth checks these tests are actually about.
process.env.SOLANA_ENABLED = "true";

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Next ships next/server without an extension-less ESM entry, so the
    // bare specifier that works under the bundler fails under node's resolver.
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    if (specifier === "next/cache") {
      const stub = path.join(__dirname, "helpers", "next-cache-stub.mjs");
      return { url: pathToFileURL(stub).href, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const target = path.join(__dirname, "..", specifier.slice(2));
      for (const candidate of [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const importTs = (...parts) =>
  import(pathToFileURL(path.join(__dirname, "..", ...parts)).href);

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Auth: every mint route, and the metadata writer that used to be open
// ---------------------------------------------------------------------------

test("POST /api/nft-metadata now requires auth", async () => {
  const { POST } = await importTs("app", "api", "nft-metadata", "route.ts");
  const res = await POST(
    jsonRequest("http://localhost/api/nft-metadata", {
      name: "x",
      image: "https://example.test/x.png",
    })
  );
  assert.strictEqual(res.status, 401, "this route was previously unauthenticated");
});

for (const route of ["prepare", "uploads", "confirm", "reject"]) {
  test(`POST /api/mint/${route} requires auth`, async () => {
    const { POST } = await importTs("app", "api", "mint", route, "route.ts");
    const res = await POST(
      jsonRequest(`http://localhost/api/mint/${route}`, { assetId: "whatever" })
    );
    assert.strictEqual(res.status, 401);
  });
}

test("GET /api/mint/[assetId] requires auth", async () => {
  const { GET } = await importTs("app", "api", "mint", "[assetId]", "route.ts");
  const res = await GET(new Request("http://localhost/api/mint/abc"), {
    params: Promise.resolve({ assetId: "abc" }),
  });
  assert.strictEqual(res.status, 401);
});

// A forged bearer token must not pass — the verifier rejects it, so the route
// behaves exactly as if nothing was supplied.
test("a forged bearer token is rejected", async () => {
  const { POST } = await importTs("app", "api", "mint", "prepare", "route.ts");
  const res = await POST(
    jsonRequest(
      "http://localhost/api/mint/prepare",
      { assetId: "x", ownerWallet: "So11111111111111111111111111111111111111112" },
      { Authorization: "Bearer not.a.real.token" }
    )
  );
  assert.strictEqual(res.status, 401);
});

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

test("isValidSolanaAddress accepts real addresses and rejects junk", async () => {
  const { isValidSolanaAddress } = await importTs("lib", "solana", "verify-mint.ts");

  assert.ok(isValidSolanaAddress("So11111111111111111111111111111111111111112"));
  assert.ok(isValidSolanaAddress("11111111111111111111111111111111"));

  for (const bad of [
    "",
    "not-base58!",
    "abc",
    "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", // an Ethereum address
    "So1111111111111111111111111111111111111111211111", // too long
    null,
    undefined,
    42,
    {},
  ]) {
    assert.ok(!isValidSolanaAddress(bad), `${JSON.stringify(bad)} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Name derivation — both sides must agree or every mint fails NAME_MISMATCH
// ---------------------------------------------------------------------------

test("onChainName truncates to the 32 chars mpl-core stores", async () => {
  const { onChainName } = await importTs("lib", "mint-service.ts");
  const long = "a".repeat(100);
  assert.strictEqual(onChainName(long).length, 32);
  assert.strictEqual(onChainName("short"), "short");
});

// ---------------------------------------------------------------------------
// Nonce
// ---------------------------------------------------------------------------

test("nonce validation: matching and unexpired only", async () => {
  const { nonceIsValid, newNonce } = await importTs("lib", "mint-service.ts");
  const now = Math.floor(Date.now() / 1000);

  const live = { nonce: "abc", nonceExpiresAt: now + 60 };
  assert.ok(nonceIsValid(live, "abc"));
  assert.ok(!nonceIsValid(live, "wrong"), "a different nonce must not pass");
  assert.ok(!nonceIsValid(live, undefined));
  assert.ok(!nonceIsValid(live, 123), "a non-string must not pass");

  assert.ok(
    !nonceIsValid({ nonce: "abc", nonceExpiresAt: now - 1 }, "abc"),
    "an expired nonce must not pass"
  );
  assert.ok(!nonceIsValid({ nonce: "abc" }, "abc"), "no expiry means not valid");
  assert.ok(!nonceIsValid({}, "abc"), "a request with no nonce must not pass");

  const fresh = newNonce();
  assert.ok(fresh.nonce.length > 0);
  assert.ok(fresh.nonceExpiresAt > now);
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

test("toMintResponse omits absent fields and flags retryable rejections", async () => {
  const { toMintResponse } = await importTs("lib", "mint-service.ts");

  const pending = toMintResponse({
    assetId: "a1",
    mintRequestId: "r1",
    status: "PENDING",
    network: "devnet",
    ownerWallet: "W",
  });
  assert.strictEqual(pending.status, "PENDING");
  assert.ok(!("mintAddress" in pending), "absent fields must be omitted, not null");
  assert.ok(!("retryAllowed" in pending));
  // The nonce is a credential; it is attached explicitly by the routes that
  // issue one, never carried along by the generic serializer.
  assert.ok(!("nonce" in pending), "the serializer must not leak the nonce");

  const rejected = toMintResponse({
    assetId: "a1",
    mintRequestId: "r1",
    status: "SIGNATURE_REJECTED",
    network: "devnet",
    ownerWallet: "W",
    pictureUri: "https://arweave.test/p",
    metadataUri: "https://arweave.test/m",
  });
  assert.strictEqual(rejected.retryAllowed, true);
  assert.strictEqual(rejected.pictureUri, "https://arweave.test/p");

  const confirmed = toMintResponse({
    assetId: "a1",
    mintRequestId: "r1",
    status: "CONFIRMED",
    network: "devnet",
    ownerWallet: "W",
    mintAddress: "M",
    txSignature: "S",
    confirmedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.strictEqual(confirmed.mintAddress, "M");
  assert.strictEqual(confirmed.transactionSignature, "S");
  assert.ok(!("retryAllowed" in confirmed));
});

// ---------------------------------------------------------------------------
// Metadata document check — the anti-tamper gate
// ---------------------------------------------------------------------------

test("metadata whose image does not match what we stored is rejected", async () => {
  const { verifyMetadataDocument } = await importTs("lib", "solana", "verify-mint.ts");
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ image: "https://evil.test/other.png" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const verdict = await verifyMetadataDocument(
      "https://arweave.test/meta",
      "https://cdn.test/ours.png"
    );
    assert.strictEqual(verdict.outcome, "rejected");
    assert.strictEqual(verdict.reason, "METADATA_IMAGE_MISMATCH");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("metadata whose image matches raises no objection", async () => {
  const { verifyMetadataDocument } = await importTs("lib", "solana", "verify-mint.ts");
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ image: "https://cdn.test/ours.png" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const verdict = await verifyMetadataDocument(
      "https://arweave.test/meta",
      "https://cdn.test/ours.png"
    );
    assert.strictEqual(verdict, null, "null means no objection");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("unreachable metadata is reported, not thrown", async () => {
  const { verifyMetadataDocument } = await importTs("lib", "solana", "verify-mint.ts");
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("gateway exploded at https://secret-endpoint?apikey=leak");
    };
    const verdict = await verifyMetadataDocument("https://arweave.test/m", "https://cdn.test/x");
    assert.strictEqual(verdict.outcome, "rejected");
    assert.strictEqual(verdict.reason, "METADATA_UNREACHABLE");
    // The coded reason is the whole point: no provider text reaches the client.
    assert.ok(!JSON.stringify(verdict).includes("apikey"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("metadata with a non-200 response is rejected", async () => {
  const { verifyMetadataDocument } = await importTs("lib", "solana", "verify-mint.ts");
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("nope", { status: 404 });
    const verdict = await verifyMetadataDocument("https://arweave.test/m", "https://cdn.test/x");
    assert.strictEqual(verdict.reason, "METADATA_UNREACHABLE");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Live RPC: an address that was never minted must not verify
// ---------------------------------------------------------------------------

test(
  "an asset that does not exist on-chain is ASSET_NOT_FOUND",
  { skip: !process.env.SOLANA_RPC_URL && "no SOLANA_RPC_URL" },
  async () => {
    const { verifyAssetOnChain } = await importTs("lib", "solana", "verify-mint.ts");
    const verdict = await verifyAssetOnChain({
      // Valid base58, correct length, but not an mpl-core asset account.
      assetAddress: "So11111111111111111111111111111111111111112",
      ownerWallet: "So11111111111111111111111111111111111111112",
      metadataUri: "https://arweave.test/m",
      expectedName: "nothing",
      expectedImageUri: "https://cdn.test/x",
    });
    assert.strictEqual(verdict.outcome, "rejected");
    // Either verdict is acceptable here; what must never happen is "verified".
    assert.ok(["ASSET_NOT_FOUND", "RPC_UNAVAILABLE"].includes(verdict.reason));
  }
);

// Both devnet verification failures so far were unreadable metadata: first a
// literal "https://$VERCEL_URL", then a preview deployment behind Vercel's SSO
// redirect. Neither returns JSON, and the asset was already minted and
// immutable by the time confirm found out.
test("metadata that is not a readable JSON document is rejected", async () => {
  const { verifyMetadataDocument } = await importTs("lib", "solana", "verify-mint.ts");

  // Serves HTML, not JSON — the shape every SSO/interstitial failure takes.
  const html = await verifyMetadataDocument("https://example.com/", "https://example.test/a.png");
  assert.strictEqual(html?.outcome, "rejected");
  assert.strictEqual(html?.reason, "METADATA_UNREACHABLE");

  const unresolvable = await verifyMetadataDocument(
    "https://$VERCEL_URL/api/nft-metadata/abc",
    "https://example.test/a.png"
  );
  assert.strictEqual(unresolvable?.outcome, "rejected");
  assert.strictEqual(unresolvable?.reason, "METADATA_UNREACHABLE");
});
