const { test } = require("node:test");
const assert = require("node:assert");

// Matches the RPC hardcoded in lib/nft.ts
const DEVNET_RPC = "https://api.devnet.solana.com";

// To run this test:
//   solana-keygen new --outfile /tmp/test-key.json
//   Fund the address at https://faucet.solana.com
//   TEST_SOLANA_PRIVATE_KEY=$(cat /tmp/test-key.json) npm test
test("nft: mints successfully on Solana devnet", { timeout: 90_000 }, async (t) => {
  const privateKeyEnv = process.env.TEST_SOLANA_PRIVATE_KEY;
  if (!privateKeyEnv) {
    t.skip("Missing TEST_SOLANA_PRIVATE_KEY (JSON byte array from solana-keygen of a devnet-funded keypair)");
    return;
  }

  // Dynamic imports required because Metaplex packages are ESM-only
  const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
  const { keypairIdentity, generateSigner, percentAmount } = await import("@metaplex-foundation/umi");
  const { mplTokenMetadata, createNft } = await import("@metaplex-foundation/mpl-token-metadata");
  const { Keypair } = await import("@solana/web3.js");

  // keypairIdentity replaces walletAdapterIdentity (which requires a browser wallet)
  const solKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(privateKeyEnv)));
  const umi = createUmi(DEVNET_RPC).use(mplTokenMetadata());
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(solKeypair.secretKey);
  umi.use(keypairIdentity(umiKeypair));

  // Mint — mirrors the createNft call in lib/nft.ts
  const mint = generateSigner(umi);
  await createNft(umi, {
    mint,
    name: "Test Meme NFT",
    symbol: "MDAY",
    uri: "https://example.com/metadata.json",
    sellerFeeBasisPoints: percentAmount(5),
    isMutable: false,
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

  const mintAddress = mint.publicKey.toString();
  assert.match(
    mintAddress,
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    "mint address should be a valid base58 public key"
  );
  t.diagnostic(`Minted NFT: ${mintAddress}`);
});
