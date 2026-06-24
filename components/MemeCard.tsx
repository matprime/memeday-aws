"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowUp, MessageCircle, ShoppingCart, Zap, Gift } from "lucide-react";
import { DbMeme } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { formatDistanceToNow } from "date-fns";
import { CreatorAvatar } from "./CreatorAvatar";
import { TipModal } from "./TipModal";

interface Props {
  meme: DbMeme;
  featured?: boolean;
  commentCount?: number;
}

function shortId(id: string) {
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

export function MemeCard({ meme, featured = false, commentCount = 0 }: Props) {
  const { cognitoToken, votedMemes, hydrateVotedMemes, voteOnMeme, addToast } = useAppStore();
  const [votes, setVotes] = useState(meme.likeCount);
  const [tipOpen, setTipOpen] = useState(false);

  // Use cognitoToken sub as the stable userId for hydrating local vote state.
  // Until Cognito auth is wired on the frontend, votedMemes persists per token.
  const userId = cognitoToken ?? null;

  useEffect(() => {
    hydrateVotedMemes(userId);
  }, [hydrateVotedMemes, userId]);

  const hasVoted = votedMemes.has(meme.id);
  const displayLabel = shortId(meme.creatorId);

  const handleVote = async () => {
    if (!cognitoToken) {
      addToast("Login with Cognito to vote", "error");
      return;
    }
    if (hasVoted) return;
    voteOnMeme(userId, meme.id);
    setVotes((v) => v + 1);
    const res = await fetch(`/api/memes/${meme.id}/vote`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cognitoToken}` },
    });
    if (!res.ok) {
      addToast("Vote failed", "error");
      setVotes((v) => v - 1);
    } else {
      addToast(`Voted for "${meme.caption.slice(0, 30)}…"`, "success");
    }
  };

  return (
    <>
    <div
      className={`group bg-surface border border-border rounded-2xl overflow-hidden transition-all hover:border-accent/50 hover:shadow-lg hover:shadow-accent/10 ${
        featured ? "ring-2 ring-bags ring-offset-2 ring-offset-bg" : ""
      }`}
    >
      <Link href={`/meme/${meme.id}`} className="block relative">
        <div className={`relative w-full overflow-hidden bg-gray-900 ${featured ? "h-72" : "h-48"}`}>
          <Image
            src={meme.imageUrl}
            alt={meme.caption}
            fill
            className="object-contain transition-transform duration-500 group-hover:scale-105"
          />
          {featured && meme.nftMint && meme.listingPrice && (
            <div className="absolute top-2 right-2 bg-black/70 backdrop-blur-sm border border-accent/50 text-accent-light text-xs font-bold px-2 py-0.5 rounded-lg">
              NFT · {meme.listingPrice} SOL
            </div>
          )}
        </div>
      </Link>

      <div className="p-4">
        <Link href={`/meme/${meme.id}`}>
          <h3 className="font-bold text-white text-sm leading-snug mb-3 hover:text-accent-light transition-colors line-clamp-2">
            {meme.caption}
          </h3>
        </Link>

        <div className="flex items-center justify-between mb-3">
          <Link href={`/creator/${meme.creatorId}`} className="flex items-center gap-2 group/creator">
            <CreatorAvatar
              seed={meme.creatorId}
              alt={displayLabel}
              size={24}
              shape="square"
              className="rounded-md"
            />
            <p className="text-xs font-semibold text-white group-hover/creator:text-accent-light transition-colors font-mono">
              {displayLabel}
            </p>
          </Link>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
              meme.nftMint
                ? "text-accent-light border-accent/40 bg-accent/10"
                : "text-gray-500 border-border/60 bg-bg/60"
            }`}>
              {meme.nftMint
                ? !featured && meme.listingPrice
                  ? `NFT · ${meme.listingPrice} SOL`
                  : "NFT"
                : "Standard"}
            </span>
            <p className="text-xs text-gray-500">
              {formatDistanceToNow(new Date(meme.createdAt), { addSuffix: true })}
            </p>
          </div>
        </div>

        {featured ? (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50">
            <button
              onClick={handleVote}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                hasVoted
                  ? "bg-accent/20 text-accent-light border border-accent/50"
                  : "bg-bg/60 text-gray-400 hover:text-white hover:bg-white/10 border border-border/50"
              }`}
            >
              <ArrowUp size={14} />
              {votes.toLocaleString()}
            </button>

            <Link
              href={`/meme/${meme.id}#comments`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white bg-bg/60 hover:bg-white/10 border border-border/50 transition-colors"
            >
              <MessageCircle size={14} />
              {commentCount}
            </Link>

            {meme.nftMint && meme.status === "listed" && (
              <button
                onClick={() => addToast("NFT purchase coming soon!", "success")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-accent-light bg-bg/60 hover:bg-accent/10 border border-border/50 hover:border-accent/50 transition-colors"
              >
                <ShoppingCart size={14} />
                Buy
              </button>
            )}

            <button
              onClick={() => setTipOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-green-500 hover:bg-green-600 text-white transition-colors"
            >
              <Gift size={14} />
              Tip
            </button>

            <button
              onClick={() => addToast("Creator token investing coming soon via Bags!", "bags")}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-bags bg-bags/10 hover:bg-bags/20 border border-bags/30 hover:border-bags/60 transition-all hover:scale-105"
            >
              <Zap size={12} />
              Invest
            </button>
          </div>
        ) : (
          <div className="mt-3 pt-3 border-t border-border/50">
            <div className="flex items-center gap-2">
              <button
                onClick={handleVote}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                  hasVoted
                    ? "bg-accent/20 text-accent-light border border-accent/50"
                    : "bg-bg/60 text-gray-400 hover:text-white hover:bg-white/10 border border-border/50"
                }`}
              >
                <ArrowUp size={14} />
                {votes.toLocaleString()}
              </button>

              <Link
                href={`/meme/${meme.id}#comments`}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white bg-bg/60 hover:bg-white/10 border border-border/50 transition-colors"
              >
                <MessageCircle size={14} />
                {commentCount}
              </Link>

              {meme.nftMint && meme.status === "listed" && (
                <button
                  onClick={() => addToast("NFT purchase coming soon!", "success")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-accent-light bg-bg/60 hover:bg-accent/10 border border-border/50 hover:border-accent/50 transition-colors"
                >
                  <ShoppingCart size={14} />
                  Buy
                </button>
              )}

              <button
                onClick={() => setTipOpen(true)}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-green-500 hover:bg-green-600 text-white transition-colors"
              >
                <Gift size={14} />
                Tip
              </button>
            </div>

            <button
              onClick={() => addToast("Creator token investing coming soon via Bags!", "bags")}
              className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-bold text-bags bg-bags/10 hover:bg-bags/20 border border-bags/30 hover:border-bags/60 transition-all"
            >
              <Zap size={14} />
              Invest in creator&apos;s token
            </button>
          </div>
        )}
      </div>
    </div>

    {tipOpen && (
      <TipModal
        creatorWallet={meme.creatorWalletAddr ?? ""}
        memeCaption={meme.caption}
        onClose={() => setTipOpen(false)}
      />
    )}
    </>
  );
}
