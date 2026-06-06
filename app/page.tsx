import { getMemeOfDay, getMemes } from "@/lib/db";
import { getTopCreators } from "@/lib/data";
import { MemeCard } from "@/components/MemeCard";
import { TrendingTokenCard } from "@/components/TrendingTokenCard";
import { Flame, Zap, Trophy } from "lucide-react";
import Link from "next/link";
import { PoweredByBagsBadge } from "@/components/BagsToast";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [memeOfDay, allMemes] = await Promise.all([getMemeOfDay(), getMemes()]);
  const recentMemes = allMemes.filter((m) => m.id !== memeOfDay?.id).slice(0, 6);
  const topCreators = getTopCreators().slice(0, 3);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-12">
      <section className="text-center space-y-4 py-4">
        <div className="inline-flex items-center gap-2 bg-bags/10 border border-bags/30 text-bags text-sm font-bold px-4 py-2 rounded-full mb-2">
          <Flame size={16} />
          Meme of the Day — Powered by Bags
        </div>
        <h1 className="text-4xl sm:text-5xl font-black text-white leading-tight">
          The Creator Economy
          <br />
          <span className="bg-hero-gradient bg-clip-text text-transparent">
            for Meme Culture
          </span>
        </h1>
        <p className="text-gray-400 max-w-xl mx-auto text-lg">
          Post memes. Earn tokens. Invest in creators. All on Solana, all via Bags.
        </p>
        <div className="flex items-center justify-center gap-3 pt-2">
          <Link
            href="/browse"
            className="bg-accent hover:bg-accent-light text-white font-bold px-6 py-3 rounded-xl transition-all hover:scale-105"
          >
            Browse Memes
          </Link>
          <Link
            href="/trending"
            className="border border-bags/50 text-bags hover:bg-bags/10 font-bold px-6 py-3 rounded-xl transition-all hover:scale-105 flex items-center gap-2"
          >
            <Zap size={16} />
            Trending Tokens
          </Link>
        </div>
      </section>

      <section className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          {memeOfDay && (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-black text-white flex items-center gap-2">
                  <Flame size={20} className="text-bags" />
                  Meme of the Day
                </h2>
                <PoweredByBagsBadge />
              </div>
              <div className="max-w-xl">
                <MemeCard meme={memeOfDay} featured />
              </div>
            </>
          )}
        </div>
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-black text-white flex items-center gap-2">
              <Trophy size={18} className="text-gold" />
              Top Creators
            </h2>
            <Link href="/leaderboard" className="text-sm text-accent-light hover:underline">
              Full board →
            </Link>
          </div>
          <div className="space-y-3">
            {topCreators.map((creator, i) => (
              <TrendingTokenCard key={creator.id} creator={creator} rank={i + 1} />
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-black text-white">Recent Memes</h2>
          <Link href="/browse" className="text-sm text-accent-light hover:underline">
            View all →
          </Link>
        </div>
        {recentMemes.length === 0 ? (
          <p className="text-gray-500 text-sm">No memes yet — be the first to post!</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {recentMemes.map((m) => (
              <MemeCard key={m.id} meme={m} />
            ))}
          </div>
        )}
      </section>

      <section className="bg-gradient-to-r from-bags/10 to-accent/10 border border-bags/20 rounded-2xl p-8 text-center">
        <div className="flex items-center justify-center gap-2 mb-3">
          <Zap size={20} className="text-bags" />
          <h2 className="text-xl font-black text-white">Creator Economy via Bags</h2>
        </div>
        <p className="text-gray-400 max-w-md mx-auto mb-5">
          Every creator on MemeDay has their own token on Bags. Invest early, earn with them as they grow. No VC, no middlemen — just memes and markets.
        </p>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <Link
            href="/leaderboard"
            className="flex items-center gap-2 border border-bags/50 text-bags font-bold px-5 py-2.5 rounded-xl hover:bg-bags/10 transition-all"
          >
            <Trophy size={16} />
            Leaderboard
          </Link>
          <Link
            href="/trending"
            className="flex items-center gap-2 bg-bags text-white font-bold px-5 py-2.5 rounded-xl hover:bg-bags-light transition-all hover:scale-105"
          >
            <Zap size={16} />
            Invest in Creators
          </Link>
        </div>
      </section>
    </div>
  );
}
