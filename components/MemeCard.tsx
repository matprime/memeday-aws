"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowUp, MessageCircle, ShoppingCart, Zap, Gift, Flag } from "lucide-react";
import { DbMeme } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { getAccessToken } from "@/lib/session";
import { formatDistanceToNow } from "date-fns";
import { CreatorAvatar } from "./CreatorAvatar";
import { TipModal } from "./TipModal";
import { ShareBar } from "./ShareBar";
import { useSolanaConfig } from "./WalletProvider";
import { EVENTS, track } from "@/lib/analytics";

interface Props {
  meme: DbMeme;
  featured?: boolean;
  commentCount?: number;
}

function shortId(id: string) {
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

export function MemeCard({ meme, featured = false, commentCount = 0 }: Props) {
  const { cognitoToken, votedMemes, hydrateVotedMemes, voteOnMeme, reportOnMeme, addToast } =
    useAppStore();
  const { enabled, disabledMessage } = useSolanaConfig();
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
    if (hasVoted) {
      addToast("You already voted for this meme", "error");
      return;
    }
    const token = await getAccessToken();
    if (!token) {
      addToast("Session expired — sign in again to vote", "error");
      return;
    }
    voteOnMeme(userId, meme.id);
    setVotes((v) => v + 1);
    const res = await fetch(`/api/memes/${meme.id}/vote`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      addToast("Vote failed", "error");
      setVotes((v) => v - 1);
      return;
    }
    const data = await res.json();
    if (data.alreadyVoted) {
      setVotes((v) => v - 1);
      addToast("You already voted for this meme", "error");
    } else {
      track(EVENTS.voteCast, { memeId: meme.id, surface: "feed" });
      addToast(`Voted for "${meme.caption.slice(0, 30)}…"`, "success");
    }
  };

  const handleReport = async () => {
    const reason = window.prompt("Why are you reporting this meme?")?.trim();
    if (!reason) return;
    const res = await fetch(`/api/memes/${meme.id}/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cognitoToken ? { Authorization: `Bearer ${cognitoToken}` } : {}),
      },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      addToast(res.status === 429 ? "Slow down — too many reports" : "Report failed", "error");
      return;
    }
    reportOnMeme(userId, meme.id);
    addToast("Reported. You won't see this in your feed anymore.", "success");
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
                ? meme.listingPrice
                  ? `NFT · ${meme.listingPrice} SOL`
                  : "NFT"
                : "Standard"}
            </span>
            <p className="text-xs text-gray-500">
              {formatDistanceToNow(new Date(meme.createdAt), { addSuffix: true })}
            </p>
          </div>
        </div>

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

            <ShareBar
              memeId={meme.id}
              caption={meme.caption}
              creatorHandle={displayLabel}
              surface="feed"
              triggerClassName="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white bg-bg/60 hover:bg-white/10 border border-border/50 transition-colors"
            />

            <button
              onClick={() =>
                meme.creatorWalletAddr
                  ? setTipOpen(true)
                  : addToast("Tipping is only available for wallet-based creators", "error")
              }
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-green-500 hover:bg-green-600 text-white transition-colors"
            >
              <Gift size={14} />
              Tip
            </button>

            <button
              onClick={handleReport}
              title="Report"
              className="flex items-center justify-center p-1.5 rounded-lg text-gray-500 hover:text-white bg-bg/60 hover:bg-white/10 border border-border/50 transition-colors"
            >
              <Flag size={14} />
            </button>
          </div>

          <button
            onClick={() =>
              addToast(
                enabled ? "Creator token investing coming soon via Bags!" : disabledMessage,
                enabled ? "bags" : "error"
              )
            }
            className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-bold text-bags bg-bags/10 hover:bg-bags/20 border border-bags/30 hover:border-bags/60 transition-all"
          >
            <Zap size={14} />
            Invest in creator&apos;s token
          </button>
        </div>
      </div>
    </div>

    {tipOpen && (
      <TipModal
        creatorWallet={meme.creatorWalletAddr ?? ""}
        memeId={meme.id}
        memeCaption={meme.caption}
        onClose={() => setTipOpen(false)}
      />
    )}
    </>
  );
}
