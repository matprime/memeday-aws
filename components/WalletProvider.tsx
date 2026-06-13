"use client";

import React, { useCallback, useMemo } from "react";
import {
  ConnectionProvider as _CP,
  WalletProvider as _WP,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider as _WMP } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { useAppStore } from "@/lib/store";

require("@solana/wallet-adapter-react-ui/styles.css");

// Cast providers to avoid @types/react 18.3 / wallet-adapter type incompatibility
const ConnectionProvider = _CP as unknown as React.FC<{ endpoint: string; children: React.ReactNode }>;
const WalletProvider = _WP as unknown as React.FC<{ wallets: any[]; autoConnect: boolean; onError: (error: Error) => void; children: React.ReactNode }>;
const WalletModalProvider = _WMP as unknown as React.FC<{ children: React.ReactNode }>;

const DEVNET_RPC = "https://api.devnet.solana.com";

export function SolanaWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const addToast = useAppStore((s) => s.addToast);

  const onWalletError = useCallback(
    (error: Error) => {
      const message =
        error.name === "WalletNotReadyError"
          ? "Phantom not detected — install the extension and reload."
          : error.message || "Wallet connection failed";
      addToast(message, "error");
    },
    [addToast]
  );

  return (
    <ConnectionProvider endpoint={DEVNET_RPC}>
      <WalletProvider wallets={wallets} autoConnect onError={onWalletError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
