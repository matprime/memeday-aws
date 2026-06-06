"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Wallet, LogOut } from "lucide-react";

export function WalletButton() {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  if (publicKey) {
    const addr = publicKey.toBase58();
    const short = `${addr.slice(0, 4)}...${addr.slice(-4)}`;
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-purple-300 bg-purple-900/30 px-3 py-1.5 rounded-full border border-purple-700/50">
          {short}
        </span>
        <button
          onClick={disconnect}
          className="text-gray-400 hover:text-red-400 transition-colors p-1.5 rounded-lg hover:bg-red-900/20"
          title="Disconnect"
        >
          <LogOut size={16} />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setVisible(true)}
      disabled={connecting}
      className="flex items-center gap-2 bg-accent hover:bg-accent-light text-white px-4 py-2 rounded-xl font-semibold text-sm transition-all hover:scale-105 active:scale-95 disabled:opacity-50"
    >
      <Wallet size={16} />
      {connecting ? "Connecting…" : "Connect Wallet"}
    </button>
  );
}

/** Renders a CTA that opens the wallet modal when action requires auth */
export function AuthGate({
  children,
  action,
}: {
  children: React.ReactNode;
  action: string;
}) {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();

  if (publicKey) return <>{children}</>;

  return (
    <button
      onClick={() => setVisible(true)}
      className="flex items-center gap-2 text-sm text-gray-400 hover:text-accent-light transition-colors border border-gray-700 hover:border-accent px-3 py-1.5 rounded-lg"
    >
      <Wallet size={14} />
      Connect wallet to {action}
    </button>
  );
}
