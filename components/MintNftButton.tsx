"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Loader2, Sparkles } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { getAccessToken } from "@/lib/session";
import { mintMemeNft } from "@/lib/nft";
import { useSolanaConfig } from "@/components/WalletProvider";
import type { MintStatus } from "@/lib/types";

// The mint is several server round-trips and an upload before the wallet is
// even asked, so the label follows the mint request's own status rather than
// claiming "approve in wallet" for the whole minute. The approval numbers match
// the count promised before the user starts — storing the image on Arweave
// costs a payment and a signature, then the mint itself.
export const MINT_STEP_LABELS: Record<string, string> = {
  PENDING: "Preparing mint…",
  UPLOADING_PICTURE: "Storing image on Arweave… (approve in wallet)",
  UPLOADING_METADATA: "Preparing NFT metadata…",
  AWAITING_SIGNATURE: "Minting NFT on Solana… (approve in wallet)",
  MINTING: "Confirming on-chain…",
};

// The mint request keys off the asset id, and a pending upload keeps its id
// when it becomes a meme, so an already-posted meme mints through exactly the
// same request a cancelled mint-at-post left behind: the stored picture and
// metadata are reused and the user never pays for that storage twice.
interface Props {
  memeId: string;
  imageUrl: string;
  caption: string;
  // The meme's current price, when it has one. A mint at post time already
  // carried its price through /api/memes, so a retry here should show that
  // rather than a blank field.
  defaultPrice?: number;
  onMinted?: () => void;
}

// The server answers asset problems with a code, not prose, so it can't be
// shown as-is. Only the ones reachable from here are named.
function readableError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Minting failed";
  if (message === "ALREADY_MINTED") return "This meme has already been minted.";
  if (message === "ASSET_NOT_OWNED") return "Only the creator can mint this meme.";
  return message;
}

export function MintNftButton({ memeId, imageUrl, caption, defaultPrice, onMinted }: Props) {
  const { rpcUrl, enabled, disabledMessage, network, storageProvider, royaltyBasisPoints } =
    useSolanaConfig();
  const wallet = useWallet();
  const { addToast } = useAppStore();
  const [minting, setMinting] = useState(false);
  const [mintStatus, setMintStatus] = useState<MintStatus | null>(null);
  const [price, setPrice] = useState(String(defaultPrice ?? "0.01"));

  // Nothing to offer without a wallet to pay and sign with.
  if (!wallet.publicKey) return null;

  const requireToken = async (): Promise<string> => {
    const token = await getAccessToken();
    if (!token) throw new Error("Session expired — sign in again");
    return token;
  };

  const handleMint = async () => {
    if (minting) return;
    if (!enabled) {
      addToast(disabledMessage, "error");
      return;
    }
    setMinting(true);
    try {
      await mintMemeNft({
        wallet,
        assetId: memeId,
        imageUrl,
        caption,
        rpcUrl,
        network,
        storageProvider,
        royaltyBasisPoints,
        // The mint spans several round-trips, so the token is renewed between
        // steps rather than captured once up front.
        getToken: requireToken,
        onStage: setMintStatus,
      });
      // The price is a separate write, and deliberately not fatal: the NFT
      // exists either way, and losing the post over a price the user can set
      // again would be the worse outcome.
      const listingPrice = parseFloat(price);
      if (Number.isFinite(listingPrice) && listingPrice > 0) {
        try {
          const res = await fetch(`/api/memes/${memeId}/listing`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${await requireToken()}`,
            },
            body: JSON.stringify({ listingPrice }),
          });
          if (!res.ok) throw new Error("price");
        } catch {
          addToast("NFT minted, but the price could not be saved.", "error");
        }
      }
      addToast("NFT minted on Solana!", "success");
      onMinted?.();
    } catch (err) {
      const message = readableError(err);
      addToast(message, "error");
      // Another tab (or an earlier attempt we never heard land) already minted
      // it. The chain is the authority, so refresh rather than leave a button
      // that can only fail.
      if (err instanceof Error && err.message === "ALREADY_MINTED") onMinted?.();
    } finally {
      setMintStatus(null);
      setMinting(false);
    }
  };

  return (
    <div className="space-y-2">
      <div>
        <label
          htmlFor={`nft-price-${memeId}`}
          className="text-xs text-gray-400 mb-1.5 block font-medium"
        >
          NFT Price (SOL)
        </label>
        <input
          id={`nft-price-${memeId}`}
          type="number"
          min="0.01"
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          disabled={minting}
          className="w-full bg-bg/60 border border-border rounded-xl px-4 py-2.5 text-white font-mono focus:outline-none focus:border-accent disabled:opacity-40"
        />
      </div>
      <button
        onClick={handleMint}
        disabled={minting}
        className="w-full flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-bold text-white bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:scale-[1.02] active:scale-[0.98] disabled:hover:scale-100"
      >
        {minting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
        {minting ? MINT_STEP_LABELS[mintStatus ?? "PENDING"] : "Mint as NFT"}
      </button>
    </div>
  );
}
