"use client";

import { getTrendingTokens, getSpikingTokens } from "@/lib/data";
import { TrendingTokenCard } from "@/components/TrendingTokenCard";
import { TrendingUp, AlertTriangle, Zap } from "lucide-react";

export default function TrendingPage() {
  const trending = getTrendingTokens();
  const spiking = getSpikingTokens();

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-2">
        <TrendingUp size={28} className="text-accent-light" />
        <h1 className="text-3xl font-black text-white">Trending Creators</h1>
      </div>
      <p className="text-gray-400 text-sm mb-8">
        Creator tokens ranked by 24h price change. Public — no login needed.
      </p>

      {/* Spike alert banner */}
      {spiking.length > 0 && (
        <div className="mb-8 bg-hot/10 border border-hot/30 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={18} className="text-hot animate-pulse" />
            <h2 className="font-black text-hot text-lg">
              Buy Spike Detected!
            </h2>
          </div>
          <p className="text-sm text-gray-400 mb-4">
            Unusual buy volume detected on{" "}
            {spiking.map((c) => `$${c.token.symbol}`).join(", ")} — potential
            momentum play. Always DYOR.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {spiking.map((creator, i) => (
              <TrendingTokenCard key={creator.id} creator={creator} rank={i + 1} />
            ))}
          </div>
        </div>
      )}

      {/* All trending */}
      <div className="mb-4 flex items-center gap-2">
        <Zap size={16} className="text-bags" />
        <h2 className="font-bold text-white">All Creator Tokens</h2>
        <span className="text-xs text-gray-500">sorted by 24h gains</span>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {trending.map((creator, i) => (
          <TrendingTokenCard key={creator.id} creator={creator} rank={i + 1} />
        ))}
      </div>

      <div className="mt-8 text-center text-xs text-gray-600">
        <p>
          All token prices and trades are executed via{" "}
          <span className="text-bags font-semibold">Bags</span> on Solana
          devnet
        </p>
      </div>
    </div>
  );
}
