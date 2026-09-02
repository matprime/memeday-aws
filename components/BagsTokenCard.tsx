import { Zap, ExternalLink } from "lucide-react";

interface Props {
  name: string;
  symbol: string;
  tokenMint: string;
}

// No "use client": pure presentation, no hooks, so both the creator profile
// (server component) and BagsLaunchClaim (client component) render the exact
// same markup and link format for a verified token (KAN-29 follow-up,
// correction 3 — "same data source, same outbound link format").
export function BagsTokenCard({ name, symbol, tokenMint }: Props) {
  return (
    <div className="bg-bags/10 border border-bags/30 rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Zap size={16} className="text-bags" />
          <p className="font-bold text-white">{name}</p>
          <span className="text-xs font-mono text-bags">${symbol}</span>
        </div>
        <p className="text-xs text-gray-500 font-mono break-all">{tokenMint}</p>
      </div>
      {/* No price/volume/market cap here — nothing numeric we haven't read
          from a verified source, per KAN-29. */}
      <a
        href={`https://bags.fm/${tokenMint}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 bg-bags hover:bg-bags-light text-white font-bold px-5 py-2.5 rounded-xl transition-all hover:scale-105 active:scale-95"
      >
        <ExternalLink size={16} />
        Trade on Bags
      </a>
    </div>
  );
}
