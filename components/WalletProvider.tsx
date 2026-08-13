"use client";

import React, { createContext, useCallback, useContext, useMemo } from "react";
import {
  ConnectionProvider as _CP,
  WalletProvider as _WP,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider as _WMP } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { useAppStore } from "@/lib/store";
import type { SolanaNetwork, SolanaExplorerCluster } from "@/lib/solana/network";

require("@solana/wallet-adapter-react-ui/styles.css");

// Cast providers to avoid @types/react 18.3 / wallet-adapter type incompatibility
const ConnectionProvider = _CP as unknown as React.FC<{ endpoint: string; children: React.ReactNode }>;
const WalletProvider = _WP as unknown as React.FC<{ wallets: any[]; autoConnect: boolean; onError: (error: Error) => void; children: React.ReactNode }>;
const WalletModalProvider = _WMP as unknown as React.FC<{ children: React.ReactNode }>;

// Validated in lib/solana/network.ts (server-only) and handed down here as
// props from app/layout.tsx, since client bundles can't read that module's
// env vars directly. This context is how the rest of the client tree
// (TipModal, PostMemeModal, analytics) reaches those values.
interface SolanaConfig {
  network: SolanaNetwork;
  rpcUrl: string;
  explorerCluster: SolanaExplorerCluster;
  enabled: boolean;
  disabledMessage: string;
}

const SolanaConfigContext = createContext<SolanaConfig | null>(null);

export function useSolanaConfig(): SolanaConfig {
  const config = useContext(SolanaConfigContext);
  if (!config) {
    throw new Error("useSolanaConfig must be used within SolanaWalletProvider");
  }
  return config;
}

export function SolanaWalletProvider({
  network,
  rpcUrl,
  explorerCluster,
  enabled,
  disabledMessage,
  children,
}: SolanaConfig & {
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

  const config = useMemo(
    () => ({ network, rpcUrl, explorerCluster, enabled, disabledMessage }),
    [network, rpcUrl, explorerCluster, enabled, disabledMessage]
  );

  return (
    <SolanaConfigContext.Provider value={config}>
      <ConnectionProvider endpoint={rpcUrl}>
        <WalletProvider wallets={wallets} autoConnect onError={onWalletError}>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </SolanaConfigContext.Provider>
  );
}
