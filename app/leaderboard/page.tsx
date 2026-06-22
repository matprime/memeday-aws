"use client";

import { useState } from "react";
import { getTopCreators } from "@/lib/data";
import { TrendingTokenCard } from "@/components/TrendingTokenCard";
import { InvestModal } from "@/components/InvestModal";
import { Creator } from "@/lib/types";
import {
  Trophy,
  TrendingUp,
  Users,
  BarChart3,
  Zap,
  Crown,
} from "lucide-react";
import Link from "next/link";
import { CreatorAvatar } from "@/components/CreatorAvatar";

export default function LeaderboardPage() {
  const creators = getTopCreators();
  const [investTarget, setInvestTarget] = useState<Creator | null>(null);

  const top3 = creators.slice(0, 3);
  const rest = creators.slice(3);

  return (
    <>
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-2">
          <Trophy size={28} className="text-gold" />
          <h1 className="text-3xl font-black text-white">Top Creators</h1>
        </div>
        <p className="text-gray-400 text-sm mb-8">
          Ranked by token trading volume. Public — no login needed.
        </p>

        {/* Podium top 3 */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          {top3.map((creator, i) => {
            const medals = ["🥇", "🥈", "🥉"];
            const heights = ["h-32", "h-24", "h-20"];
            const order = [1, 0, 2]; // center first visually
            return (
              <div
                key={creator.id}
                className={`flex flex-col items-center gap-3 ${order[i] === 1 ? "order-first" : ""}`}
                style={{ order: order[i] }}
              >
                <div className="text-3xl">{medals[i]}</div>
                <Link href={`/creator/${creator.id}`} className="flex flex-col items-center gap-2 group">
                  <div className="relative">
                    <CreatorAvatar
                      seed={creator.id ?? creator.username}
                      alt={creator.username}
                      size={i === 0 ? 64 : 52}
                      className="border-2 border-gold/30 group-hover:border-gold/70 transition-colors"
                    />
                    {i === 0 && (
                      <Crown
                        size={16}
                        className="absolute -top-2 -right-1 text-gold"
                      />
                    )}
                  </div>
                  <p className="text-xs font-bold text-white text-center group-hover:text-accent-light transition-colors">
                    {creator.username}
                  </p>
                  <p className="text-xs text-bags font-mono font-bold">
                    ${creator.token.symbol}
                  </p>
                </Link>
                <div
                  className={`w-full ${heights[i]} bg-gradient-to-t from-accent/30 to-accent/10 border border-accent/20 rounded-t-xl flex items-end justify-center pb-2`}
                >
                  <p className="text-xs text-white font-semibold">
                    {creator.token.totalVolume.toFixed(0)} SOL
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Full leaderboard table */}
        <div className="bg-surface border border-border rounded-2xl overflow-hidden">
          <div className="grid grid-cols-6 gap-4 px-5 py-3 border-b border-border text-xs text-gray-500 font-semibold uppercase tracking-wider">
            <span className="col-span-2">Creator</span>
            <span className="flex items-center gap-1">
              <BarChart3 size={12} /> Price
            </span>
            <span className="flex items-center gap-1">
              <TrendingUp size={12} /> 24h
            </span>
            <span className="flex items-center gap-1">
              <Users size={12} /> Holders
            </span>
            <span>Action</span>
          </div>

          {creators.map((creator, i) => (
            <div
              key={creator.id}
              className="grid grid-cols-6 gap-4 px-5 py-4 border-b border-border/50 last:border-0 hover:bg-white/3 transition-colors items-center"
            >
              <div className="col-span-2 flex items-center gap-3">
                <span className="text-gray-600 font-bold w-5 text-sm">
                  {i + 1}
                </span>
                <CreatorAvatar
                  seed={creator.id ?? creator.username}
                  alt={creator.username}
                  size={36}
                />
                <div>
                  <Link
                    href={`/creator/${creator.id}`}
                    className="text-sm font-semibold text-white hover:text-accent-light transition-colors"
                  >
                    {creator.username}
                  </Link>
                  <p className="text-xs text-bags font-mono">
                    ${creator.token.symbol}
                  </p>
                </div>
              </div>

              <span className="text-sm font-mono text-white">
                {creator.token.price} SOL
              </span>

              <span
                className={`text-sm font-semibold ${
                  creator.token.priceChange24h > 0
                    ? "text-green-400"
                    : "text-red-400"
                }`}
              >
                {creator.token.priceChange24h > 0 ? "+" : ""}
                {creator.token.priceChange24h}%
              </span>

              <span className="text-sm text-gray-300">
                {creator.token.holders.toLocaleString()}
              </span>

              <button
                onClick={() => setInvestTarget(creator)}
                className="flex items-center gap-1.5 text-xs font-bold text-bags bg-bags/10 hover:bg-bags/20 border border-bags/30 hover:border-bags/60 px-3 py-1.5 rounded-lg transition-all w-fit"
              >
                <Zap size={11} />
                Invest
              </button>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-gray-600 mt-4">
          Rankings update in real-time based on Bags token trading volume
        </p>
      </div>

      {investTarget && (
        <InvestModal
          creator={investTarget}
          onClose={() => setInvestTarget(null)}
        />
      )}
    </>
  );
}
