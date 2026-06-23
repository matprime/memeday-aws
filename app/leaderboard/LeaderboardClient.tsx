"use client";

import { useState } from "react";
import { InvestModal } from "@/components/InvestModal";
import { Creator } from "@/lib/types";
import {
  Trophy,
  TrendingUp,
  Users,
  BarChart3,
  Zap,
  Crown,
  ImageIcon,
  X,
} from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { CreatorAvatar } from "@/components/CreatorAvatar";

type DisplayMeme = { id: string; imageUrl: string; caption: string; isNFT: boolean };

interface Props {
  creatorsByVolume: Creator[];
  creatorsByMemes: Creator[];
  memesMap: Record<string, DisplayMeme[]>;
}

export function LeaderboardClient({ creatorsByVolume, creatorsByMemes, memesMap }: Props) {
  const [tab, setTab] = useState<"volume" | "memes">("volume");
  const [investTarget, setInvestTarget] = useState<Creator | null>(null);
  const [selectedCreator, setSelectedCreator] = useState<Creator | null>(null);

  const top3 = creatorsByVolume.slice(0, 3);
  const selectedMemes: DisplayMeme[] = selectedCreator ? (memesMap[selectedCreator.id] ?? []) : [];

  return (
    <>
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-2">
          <Trophy size={28} className="text-gold" />
          <h1 className="text-3xl font-black text-white">Leaderboard</h1>
        </div>
        <p className="text-gray-400 text-sm mb-6">
          Public — no login needed.
        </p>

        {/* Tab switcher */}
        <div className="flex gap-2 mb-8 border-b border-border">
          <button
            onClick={() => setTab("volume")}
            className={`pb-3 px-4 text-sm font-semibold transition-colors border-b-2 -mb-px ${
              tab === "volume"
                ? "border-accent text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            <span className="flex items-center gap-2">
              <BarChart3 size={14} /> Top Creators by Volume
            </span>
          </button>
          <button
            onClick={() => setTab("memes")}
            className={`pb-3 px-4 text-sm font-semibold transition-colors border-b-2 -mb-px ${
              tab === "memes"
                ? "border-accent text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            <span className="flex items-center gap-2">
              <ImageIcon size={14} /> Top Creators by Meme Count
            </span>
          </button>
        </div>

        {tab === "volume" && (
          <>
            <p className="text-gray-500 text-xs mb-6">Ranked by token trading volume.</p>

            {/* Podium top 3 */}
            <div className="grid grid-cols-3 gap-4 mb-8">
              {top3.map((creator, i) => {
                const medals = ["🥇", "🥈", "🥉"];
                const heights = ["h-32", "h-24", "h-20"];
                const order = [1, 0, 2];
                return (
                  <div key={creator.id} className="flex flex-col items-center gap-3" style={{ order: order[i] }}>
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
                          <Crown size={16} className="absolute -top-2 -right-1 text-gold" />
                        )}
                      </div>
                      <p className="text-xs font-bold text-white text-center group-hover:text-accent-light transition-colors flex items-center justify-center gap-1">
                        {creator.username}
                        {creator.isDemo && (
                          <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 text-yellow-400 leading-none">DEMO</span>
                        )}
                      </p>
                      <p className="text-xs text-bags font-mono font-bold">${creator.token.symbol}</p>
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

            {/* Full table */}
            <div className="bg-surface border border-border rounded-2xl overflow-hidden">
              <div className="grid grid-cols-6 gap-4 px-5 py-3 border-b border-border text-xs text-gray-500 font-semibold uppercase tracking-wider">
                <span className="col-span-2">Creator</span>
                <span className="flex items-center gap-1"><BarChart3 size={12} /> Price</span>
                <span className="flex items-center gap-1"><TrendingUp size={12} /> 24h</span>
                <span className="flex items-center gap-1"><Users size={12} /> Holders</span>
                <span>Action</span>
              </div>

              {creatorsByVolume.map((creator, i) => (
                <div
                  key={creator.id}
                  className="grid grid-cols-6 gap-4 px-5 py-4 border-b border-border/50 last:border-0 hover:bg-white/3 transition-colors items-center"
                >
                  <div className="col-span-2 flex items-center gap-3">
                    <span className="text-gray-600 font-bold w-5 text-sm">{i + 1}</span>
                    <CreatorAvatar seed={creator.id ?? creator.username} alt={creator.username} size={36} />
                    <div>
                      <Link href={`/creator/${creator.id}`} className="text-sm font-semibold text-white hover:text-accent-light transition-colors inline-flex items-center gap-1">
                        {creator.username}
                        {creator.isDemo && (
                          <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 text-yellow-400 leading-none">DEMO</span>
                        )}
                      </Link>
                      <p className="text-xs text-bags font-mono">${creator.token.symbol}</p>
                    </div>
                  </div>
                  <span className="text-sm font-mono text-white">{creator.token.price} SOL</span>
                  <span className={`text-sm font-semibold ${creator.token.priceChange24h > 0 ? "text-green-400" : "text-red-400"}`}>
                    {creator.token.priceChange24h > 0 ? "+" : ""}{creator.token.priceChange24h}%
                  </span>
                  <span className="text-sm text-gray-300">{creator.token.holders.toLocaleString()}</span>
                  <button
                    onClick={() => setInvestTarget(creator)}
                    className="flex items-center gap-1.5 text-xs font-bold text-bags bg-bags/10 hover:bg-bags/20 border border-bags/30 hover:border-bags/60 px-3 py-1.5 rounded-lg transition-all w-fit"
                  >
                    <Zap size={11} /> Invest
                  </button>
                </div>
              ))}
            </div>

            <p className="text-center text-xs text-gray-600 mt-4">
              Rankings update in real-time based on Bags token trading volume
            </p>
          </>
        )}

        {tab === "memes" && (
          <>
            <p className="text-gray-500 text-xs mb-6">
              Ranked by total memes posted. Includes demo creators and app users. Click a creator to see their memes.
            </p>

            <div className="bg-surface border border-border rounded-2xl overflow-hidden">
              <div className="grid grid-cols-4 gap-4 px-5 py-3 border-b border-border text-xs text-gray-500 font-semibold uppercase tracking-wider">
                <span className="col-span-2">Creator</span>
                <span className="flex items-center gap-1"><ImageIcon size={12} /> Memes</span>
                <span>View</span>
              </div>

              {creatorsByMemes.map((creator, i) => (
                <div
                  key={creator.id}
                  className="grid grid-cols-4 gap-4 px-5 py-4 border-b border-border/50 last:border-0 hover:bg-white/3 transition-colors items-center"
                >
                  <div className="col-span-2 flex items-center gap-3">
                    <span className="text-gray-600 font-bold w-5 text-sm">{i + 1}</span>
                    <CreatorAvatar seed={creator.id ?? creator.username} alt={creator.username} size={36} />
                    <div>
                      <p className="text-sm font-semibold text-white flex items-center gap-1">
                        {creator.username}
                        {creator.isDemo && (
                          <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 text-yellow-400 leading-none">DEMO</span>
                        )}
                      </p>
                      <p className="text-xs text-bags font-mono">${creator.token.symbol}</p>
                    </div>
                  </div>
                  <span className="text-sm font-semibold text-white">
                    {creator.memeCount.toLocaleString()}
                  </span>
                  <button
                    onClick={() => setSelectedCreator(creator)}
                    className="flex items-center gap-1.5 text-xs font-bold text-accent-light bg-accent/10 hover:bg-accent/20 border border-accent/30 hover:border-accent/60 px-3 py-1.5 rounded-lg transition-all w-fit"
                  >
                    <ImageIcon size={11} /> Memes
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Memes modal */}
      {selectedCreator && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => setSelectedCreator(null)}
        >
          <div
            className="bg-surface border border-border rounded-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <CreatorAvatar seed={selectedCreator.id ?? selectedCreator.username} alt={selectedCreator.username} size={36} />
                <div>
                  <p className="font-bold text-white flex items-center gap-1.5">
                    {selectedCreator.username}
                    {selectedCreator.isDemo && (
                      <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 text-yellow-400 leading-none">DEMO</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-400">{selectedCreator.memeCount} memes</p>
                </div>
              </div>
              <button onClick={() => setSelectedCreator(null)} className="text-gray-500 hover:text-white transition-colors">
                <X size={20} />
              </button>
            </div>

            <div className="overflow-y-auto p-4">
              {selectedMemes.length === 0 ? (
                <p className="text-center text-gray-500 py-8">No memes found for this creator.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {selectedMemes.map((meme) => (
                    <Link key={meme.id} href={`/meme/${meme.id}`} onClick={() => setSelectedCreator(null)}>
                      <div className="flex flex-col rounded-xl overflow-hidden border border-border hover:border-accent/50 transition-colors group">
                        <div className="relative aspect-square">
                          <Image
                            src={meme.imageUrl}
                            alt={meme.caption}
                            fill
                            className="object-cover group-hover:scale-105 transition-transform duration-200"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
                            <p className="text-xs text-white font-semibold line-clamp-2">{meme.caption}</p>
                          </div>
                        </div>
                        <div className="px-2 py-1.5 bg-surface">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
                            meme.isNFT
                              ? "text-accent-light border-accent/40 bg-accent/10"
                              : "text-gray-500 border-border/60 bg-bg/60"
                          }`}>
                            {meme.isNFT ? "NFT" : "Standard"}
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {investTarget && (
        <InvestModal creator={investTarget} onClose={() => setInvestTarget(null)} />
      )}
    </>
  );
}
