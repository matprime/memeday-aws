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
