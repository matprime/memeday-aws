const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODULE_PATH = path.join(__dirname, "..", "lib", "nft-shared.ts");

async function load() {
  return import(pathToFileURL(MODULE_PATH).href);
}

// A decline and a failure are handled differently: a decline parks the mint
// request as retryable and keeps the paid-for uploads, anything else is
// surfaced as an error. Misreading one as the other either tells a user their
// mint broke when they only said no, or hides a real failure behind "declined".
test("mint client: a declined signature is recognised in every shape a wallet reports it", async () => {
  const { isUserRejection } = await load();

  const walletAdapterError = new Error("User rejected the request.");
  walletAdapterError.name = "WalletSignTransactionError";
  assert.equal(isUserRejection(walletAdapterError), true);

  assert.equal(isUserRejection({ code: 4001, message: "User rejected" }), true);
  assert.equal(isUserRejection({ error: { code: 4001 } }), true);
  assert.equal(isUserRejection(new Error("User declined the transaction")), true);
  assert.equal(isUserRejection(new Error("Request rejected by user")), true);
  // KAN-11: Phantom reports a closed popup this way, with no code and no
  // "rejected" anywhere in it.
  assert.equal(isUserRejection(new Error("Plugin Closed")), true);
});

test("mint client: a transport or program failure is never treated as a decline", async () => {
  const { isUserRejection } = await load();

  assert.equal(isUserRejection(new TypeError("Failed to fetch")), false);
  assert.equal(isUserRejection(new Error("blockhash not found")), false);
  assert.equal(isUserRejection(new Error("insufficient funds for rent")), false);
  assert.equal(isUserRejection({ code: 500 }), false);
  assert.equal(isUserRejection(null), false);
  assert.equal(isUserRejection("User rejected"), false);
});

test("mint client: uris that cannot go on-chain are rejected before the wallet is asked", async () => {
  const { checkUri, MAX_ON_CHAIN_URI_LEN } = await load();

  const ok = "https://gateway.irys.xyz/abc";
  assert.equal(checkUri(ok, "Metadata URI"), ok);

  assert.throws(() => checkUri("http://gateway.irys.xyz/abc", "Metadata URI"), /https/);
  assert.throws(() => checkUri("/api/image/key.jpg", "Image URI"), /https/);

  const tooLong = `https://gateway.irys.xyz/${"a".repeat(MAX_ON_CHAIN_URI_LEN)}`;
  assert.throws(() => checkUri(tooLong, "Metadata URI"), /too long/);
  assert.equal(MAX_ON_CHAIN_URI_LEN, 200);
});

// A deployment with NEXT_PUBLIC_APP_URL set to the literal "https://$VERCEL_URL"
// minted an asset whose metadata uri no one can resolve. ImmutableMetadata means
// that NFT is permanently broken, so the check has to happen before the mint.
test("mint client: a uri whose host cannot resolve is refused before the wallet is asked", async () => {
  const { checkUri } = await load();

  assert.throws(() => checkUri("https://$VERCEL_URL/api/nft-metadata/abc", "Metadata URI"), /resolvable/);
  assert.throws(() => checkUri("https://localhost:3000/api/nft-metadata/abc", "Metadata URI"), /resolvable/);
  assert.throws(() => checkUri("https:///api/nft-metadata/abc", "Metadata URI"), /resolvable|valid URL/);

  const real = "https://memeday.vercel.app/api/nft-metadata/abc";
  assert.equal(checkUri(real, "Metadata URI"), real);
  assert.equal(
    checkUri("https://gateway.irys.xyz/xyz", "Image URI"),
    "https://gateway.irys.xyz/xyz"
  );
});

// The verifier compares the on-chain name against the server's own truncation
// (lib/mint-service.ts). If the two ever disagree the mint is rejected as
// NAME_MISMATCH after the user has already paid for it.
test("mint client: the on-chain name matches the server's truncation exactly", async () => {
  const { onChainName } = await load();
  const serverSource = require("node:fs").readFileSync(
    path.join(__dirname, "..", "lib", "mint-service.ts"),
    "utf8"
  );
  assert.match(serverSource, /export function onChainName\(caption: string\): string \{\s*return caption\.slice\(0, 32\);/);

  const long = "x".repeat(64);
  assert.equal(onChainName(long).length, 32);
  assert.equal(onChainName("short caption"), "short caption");
  // Truncation is by UTF-16 code unit on both sides, emoji included.
  const emoji = "😀".repeat(20);
  assert.equal(onChainName(emoji), emoji.slice(0, 32));
});

// KAN-11: a cancelled storage payment left the uploader returning nothing, and
// the mint died on "Cannot read properties of undefined (reading 'startsWith')"
// instead of naming the step.
test("checkUri: a missing uri names the step rather than throwing a TypeError", async () => {
  const { checkUri } = await load();

  assert.throws(() => checkUri(undefined, "Image URI"), /Image URI is missing/);
  assert.throws(() => checkUri("", "Image URI"), /Image URI is missing/);
});

// ---------------------------------------------------------------------------
// KAN-10 residual: the metadata document builder, shared by the s3-mode GET
// route (reading a stored row) and the irys-mode client (uploading straight
// to Arweave, no row ever written).
// ---------------------------------------------------------------------------

test("imageMimeFromUrl: recognised extensions, query strings stripped first", async () => {
  const { imageMimeFromUrl } = await load();

  assert.equal(imageMimeFromUrl("https://cdn.test/a.png"), "image/png");
  assert.equal(imageMimeFromUrl("https://cdn.test/a.gif"), "image/gif");
  assert.equal(imageMimeFromUrl("https://cdn.test/a.webp"), "image/webp");
  assert.equal(imageMimeFromUrl("https://cdn.test/a.jpg"), "image/jpeg");
  assert.equal(imageMimeFromUrl("https://cdn.test/a.PNG?x=1"), "image/png");
  // Known gap (not fixed here, listed in the report): an extensionless
  // Arweave gateway url falls through to this default even for a PNG.
  assert.equal(imageMimeFromUrl("https://gateway.irys.xyz/abc123"), "image/jpeg");
});

test("buildNftMetadataDoc: shape matches what the on-chain uri must resolve to", async () => {
  const { buildNftMetadataDoc } = await load();

  const doc = buildNftMetadataDoc({
    name: "My Meme",
    description: "Meme NFT - MemeDay on Solana",
    image: "https://cdn.test/a.png",
  });
  assert.deepEqual(doc, {
    name: "My Meme",
    symbol: "MDAY",
    description: "Meme NFT - MemeDay on Solana",
    image: "https://cdn.test/a.png",
    properties: {
      files: [{ uri: "https://cdn.test/a.png", type: "image/png" }],
      category: "image",
    },
  });
});

// GET /api/nft-metadata/[id] cannot run here without a live DynamoDB table
// (see test/mint-api.test.js for routes that can), so this checks the same
// thing mint-api.test.js checks for onChainName: the route's source calls the
// shared builder with the row's own fields, untransformed, so an existing s3
// row reads back exactly as it did before this function existed.
test("the GET route builds its response with buildNftMetadataDoc, not its own copy", async () => {
  const routeSource = require("node:fs").readFileSync(
    path.join(__dirname, "..", "app", "api", "nft-metadata", "[id]", "route.ts"),
    "utf8"
  );
  assert.match(routeSource, /from ["']@\/lib\/nft-shared["']/);
  assert.match(
    routeSource,
    /buildNftMetadataDoc\(\{\s*name:\s*row\.name,\s*description:\s*row\.description,\s*image:\s*row\.image_url,?\s*\}\)/
  );
});
