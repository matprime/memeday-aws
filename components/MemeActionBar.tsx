"use client";

import { useEffect, useState } from "react";
import { ArrowUp, MessageCircle, ShoppingCart, ShoppingBag, Zap, Gift } from "lucide-react";
import { DbMeme, Creator } from "@/lib/types";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useAppStore } from "@/lib/store";
import { InvestModal } from "./InvestModal";
import { TipModal } from "./TipModal";

interface Props {
  meme: DbMeme;
  creator: Creator;
  commentCount?: number;
}

export function MemeActionBar({ meme, creator, commentCount = 0 }: Props) {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { votedMemes, hydrateVotedMemes, voteOnMeme, addToast } = useAppStore();
  const [investOpen, setInvestOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [votes, setVotes] = useState(meme.total_votes);

  const wallet = publicKey?.toBase58() ?? null;

  useEffect(() => {
    hydrateVotedMemes(wallet);
  }, [hydrateVotedMemes, wallet]);

  const hasVoted = votedMemes.has(meme.id);
  const displayVotes = votes;

  const handleVote = async () => {
    if (!publicKey) { setVisible(true); return; }
    if (hasVoted) return;
    voteOnMeme(wallet, meme.id);
    setVotes((v) => v + 1);
    const res = await fetch(`/api/memes/${meme.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet_address: wallet }),
    });
    if (!res.ok) throw new Error("Vote failed");
    addToast("Vote recorded!", "success");
  };

  return (
    <>
      <div className="flex flex-col gap-3 bg-surface border border-border rounded-2xl p-4">
        {/* Votes, comments, optional NFT buy */}
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleVote}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold transition-all ${
              hasVoted
                ? "bg-accent text-white"
                : "bg-bg/60 text-gray-300 hover:text-white hover:bg-white/10 border border-border"
            }`}
          >
            <ArrowUp size={16} />
            {displayVotes.toLocaleString()} votes
          </button>

          <a
            href="#comments"
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold bg-bg/60 text-gray-300 hover:text-white hover:bg-white/10 border border-border transition-colors"
          >
            <MessageCircle size={16} />
            {commentCount} comments
          </a>

          {meme.is_nft && meme.price && (
            <button
              onClick={() => publicKey ? addToast("NFT purchase coming soon!", "success") : setVisible(true)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold bg-accent/10 text-accent-light hover:bg-accent/20 border border-accent/30 transition-colors"
            >
              <ShoppingCart size={16} />
              Buy NFT · {meme.price} SOL
            </button>
          )}
        </div>

        {/* Row 1: Tip Creator + Buy Meme NFT — equal width */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setTipOpen(true)}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-semibold bg-green-500 hover:bg-green-600 text-white transition-colors"
          >
            <Gift size={16} />
            Tip Creator
          </button>

          <button
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-semibold bg-blue-500 hover:bg-blue-600 text-white transition-colors"
          >
            <ShoppingBag size={16} />
            Buy Meme NFT
          </button>
        </div>

        {/* Row 2: Trade meme token — full width */}
        <button
          onClick={() => setInvestOpen(true)}
          className="w-full flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-bold text-white bg-orange-500 hover:bg-orange-600 transition-all hover:scale-[1.02] active:scale-[0.98]"
        >
          <Zap size={16} />
          Trade meme token
        </button>
      </div>

      {investOpen && (
        <InvestModal creator={creator} onClose={() => setInvestOpen(false)} />
      )}

      {tipOpen && (
        <TipModal
          creatorWallet={meme.creator_wallet}
          memeCaption={meme.caption}
          onClose={() => setTipOpen(false)}
        />
      )}
    </>
  );
}
