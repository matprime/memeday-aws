"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Flame, Trophy, TrendingUp, LayoutGrid, Plus } from "lucide-react";
import { WalletButton } from "./WalletButton";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useState } from "react";
import { PostMemeModal } from "./PostMemeModal";

const NAV = [
  { href: "/", label: "Today", icon: Flame },
  { href: "/browse", label: "Browse", icon: LayoutGrid },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/trending", label: "Trending", icon: TrendingUp },
];

export function Navbar() {
  const pathname = usePathname();
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const [postOpen, setPostOpen] = useState(false);

  const handlePostClick = () => {
    if (!publicKey) {
      setVisible(true);
    } else {
      setPostOpen(true);
    }
  };

  return (
    <>
      <nav className="sticky top-0 z-40 bg-bg/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-6xl mx-auto px-4 flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 bg-hero-gradient rounded-xl flex items-center justify-center text-lg font-black">
              🔥
            </div>
            <span className="font-black text-white text-lg tracking-tight">
              Meme<span className="text-accent-light">Day</span>
            </span>
          </Link>

          {/* Nav links */}
          <div className="hidden md:flex items-center gap-1">
            {NAV.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  pathname === href
                    ? "bg-accent/20 text-accent-light"
                    : "text-gray-400 hover:text-white hover:bg-white/5"
                }`}
              >
                <Icon size={15} />
                {label}
              </Link>
            ))}
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            <button
              onClick={handlePostClick}
              className="hidden sm:flex items-center gap-1.5 bg-accent hover:bg-accent-light text-white px-3 py-2 rounded-xl font-semibold text-sm transition-all hover:scale-105 active:scale-95"
            >
              <Plus size={15} />
              Post Meme
            </button>
            <WalletButton />
          </div>
        </div>

        {/* Mobile nav */}
        <div className="md:hidden flex border-t border-border">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-xs transition-colors ${
                pathname === href ? "text-accent-light" : "text-gray-500"
              }`}
            >
              <Icon size={18} />
              {label}
            </Link>
          ))}
        </div>
      </nav>

      {postOpen && <PostMemeModal onClose={() => setPostOpen(false)} />}
    </>
  );
}
