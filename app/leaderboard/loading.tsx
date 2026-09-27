import { Trophy } from "lucide-react";

export default function LeaderboardLoading() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-2">
        <Trophy size={28} className="text-gold" />
        <h1 className="text-3xl font-black text-white">Leaderboard</h1>
      </div>
      <p className="text-gray-400 text-sm mb-6">Public, no login needed.</p>

      <div className="flex gap-2 mb-8 border-b border-border">
        <div className="pb-3 px-4">
          <div className="h-4 w-28 rounded bg-white/10 animate-pulse" />
        </div>
        <div className="pb-3 px-4">
          <div className="h-4 w-40 rounded bg-white/5 animate-pulse" />
        </div>
        <div className="pb-3 px-4">
          <div className="h-4 w-36 rounded bg-white/5 animate-pulse" />
        </div>
      </div>

      <div className="bg-surface border border-border rounded-2xl overflow-hidden">
        <div className="grid grid-cols-4 gap-4 px-5 py-3 border-b border-border text-xs text-gray-500 font-semibold uppercase tracking-wider">
          <span className="col-span-2">Creator</span>
          <span>Points</span>
          <span>Profile</span>
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-4 gap-4 px-5 py-4 border-b border-border/50 last:border-0 items-center"
          >
            <div className="col-span-2 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-white/10 animate-pulse" />
              <div className="h-4 w-24 rounded bg-white/10 animate-pulse" />
            </div>
            <div className="h-4 w-12 rounded bg-white/10 animate-pulse" />
            <div className="h-4 w-16 rounded bg-white/10 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
