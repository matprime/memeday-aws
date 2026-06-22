"use client";

import { useState } from "react";
import Link from "next/link";
import { TrendingUp, TrendingDown, Zap, Users, AlertTriangle } from "lucide-react";
import { Creator } from "@/lib/types";
import { InvestModal } from "./InvestModal";
import { CreatorAvatar } from "./CreatorAvatar";

interface Props {
  creator: Creator;
  rank: number;
}

export function TrendingTokenCard({ creator, rank }: Props) {
  const [investOpen, setInvestOpen] = useState(false);
  const positive = creator.token.priceChange24h > 0;

  return (
    <>
      <div
        className={`bg-surface border rounded-2xl p-4 transition-all hover:shadow-lg group ${
          creator.token.spiking
            ? "border-hot/40 hover:border-hot/70 hover:shadow-hot/10"
            : "border-border hover:border-accent/50 hover:shadow-accent/10"
        }`}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-black text-gray-600 w-7 text-center">
              {rank}
            </span>
            <Link href={`/creator/${creator.id}`} className="flex items-center gap-2">
              <CreatorAvatar seed={creator.id ?? creator.username} alt={creator.username} size={40} />
              <div>
                <p className="font-bold text-white text-sm group-hover:text-accent-light transition-colors flex items-center gap-1">
                  {creator.username}
                  {creator.isDemo && (
                    <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 text-yellow-400 leading-none">DEMO</span>
                  )}
                </p>
                <p className="text-xs text-bags font-mono font-bold">
                  ${creator.token.symbol}
                </p>
              </div>
            </Link>
          </div>

          {/* Spike badge */}
          {creator.token.spiking && (
            <div className="flex items-center gap-1 bg-hot/15 border border-hot/40 text-hot text-xs font-bold px-2 py-1 rounded-lg animate-pulse">
              <AlertTriangle size={10} />
              BUY SPIKE
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="text-center">
            <p className="text-xs text-gray-500 mb-0.5">Price</p>
            <p className="text-sm font-bold text-white font-mono">
              {creator.token.price} SOL
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500 mb-0.5">24h</p>
            <p
              className={`text-sm font-bold flex items-center justify-center gap-0.5 ${
                positive ? "text-green-400" : "text-red-400"
              }`}
            >
              {positive ? (
                <TrendingUp size={12} />
              ) : (
                <TrendingDown size={12} />
              )}
              {positive ? "+" : ""}
              {creator.token.priceChange24h}%
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500 mb-0.5">Holders</p>
            <p className="text-sm font-bold text-white flex items-center justify-center gap-0.5">
              <Users size={11} />
              {creator.token.holders}
            </p>
          </div>
        </div>

        {/* Volume bar */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500">Volume (SOL)</span>
            <span className="text-xs font-mono text-gray-300">
              {creator.token.totalVolume.toFixed(1)}
            </span>
          </div>
          <div className="h-1.5 bg-bg/60 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                creator.token.spiking
                  ? "bg-gradient-to-r from-hot to-bags"
                  : "bg-gradient-to-r from-accent to-accent-light"
              }`}
              style={{ width: `${Math.min((creator.token.totalVolume / 220) * 100, 100)}%` }}
            />
          </div>
        </div>

        <button
          onClick={() => setInvestOpen(true)}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold text-bags bg-bags/10 hover:bg-bags/20 border border-bags/30 hover:border-bags/60 transition-all hover:scale-[1.02] active:scale-[0.98]"
        >
          <Zap size={14} />
          Invest
        </button>
      </div>

      {investOpen && (
        <InvestModal creator={creator} onClose={() => setInvestOpen(false)} />
      )}
    </>
  );
}
