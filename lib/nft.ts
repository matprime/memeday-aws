import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  walletAdapterIdentity,
} from "@metaplex-foundation/umi-signer-wallet-adapters";
import {
  createNft,
  mplTokenMetadata,
} from "@metaplex-foundation/mpl-token-metadata";
import { generateSigner, percentAmount } from "@metaplex-foundation/umi";
import type { WalletContextState } from "@solana/wallet-adapter-react";

const DEVNET_RPC = "https://api.devnet.solana.com";
const MAX_ON_CHAIN_URI_LEN = 200;

async function registerMetadataUri(
  imageUrl: string,
  caption: string
): Promise<string> {
  const base =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_APP_URL ?? "";

  const res = await fetch(`${base}/api/nft-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: caption.slice(0, 32),
      image: imageUrl,
      description: "Meme NFT — MemeDay on Solana",
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      (err as { error?: string }).error ??
        `Metadata registration failed (${res.status})`
    );
  }

  const { uri } = (await res.json()) as { uri: string };
  if (!uri?.startsWith("http")) {
    throw new Error(`Invalid metadata URI: ${uri ?? "empty"}`);
  }
  if (uri.length > MAX_ON_CHAIN_URI_LEN) {
    throw new Error(
      `Metadata URI too long (${uri.length} chars, max ${MAX_ON_CHAIN_URI_LEN})`
    );
  }
  return uri;
}

export async function mintMemeNft(
  wallet: WalletContextState,
  _walletAddress: string,
  imageUrl: string,
  caption: string
): Promise<string> {
  const metadataUri = await registerMetadataUri(imageUrl, caption);

  // Mint NFT on devnet — Phantom will prompt the user to sign
  const umi = createUmi(DEVNET_RPC)
    .use(mplTokenMetadata())
    .use(walletAdapterIdentity(wallet as any));

  const mint = generateSigner(umi);
  await createNft(umi, {
    mint,
    name: caption.slice(0, 32),
    symbol: "MDAY",
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(5),
    isMutable: false,
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

  return mint.publicKey.toString();
}
