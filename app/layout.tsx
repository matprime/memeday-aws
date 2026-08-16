import type { Metadata } from "next";
import "./globals.css";
import { SolanaWalletProvider } from "@/components/WalletProvider";
import { Navbar } from "@/components/Navbar";
import { BagsToastContainer } from "@/components/BagsToast";
import { WalletAuthSync } from "@/components/WalletAuthSync";
import { AnalyticsInit } from "@/components/AnalyticsInit";
import { Analytics } from "@vercel/analytics/next";
import {
  SOLANA_NETWORK,
  SOLANA_CLIENT_RPC_PATH,
  SOLANA_EXPLORER_CLUSTER,
  SOLANA_ENABLED,
  SOLANA_DISABLED_MESSAGE,
} from "@/lib/solana/network";

export const metadata: Metadata = {
  title: "MemeDay — Creator Economy on Solana",
  description:
    "Post memes, earn creator tokens, and invest in your favorite meme creators via Bags.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <SolanaWalletProvider
          network={SOLANA_NETWORK}
          rpcPath={SOLANA_CLIENT_RPC_PATH}
          explorerCluster={SOLANA_EXPLORER_CLUSTER}
          enabled={SOLANA_ENABLED}
          disabledMessage={SOLANA_DISABLED_MESSAGE}
        >
          <WalletAuthSync />
          <AnalyticsInit />
          <Navbar />
          <main className="min-h-screen">{children}</main>
          <BagsToastContainer />
          <footer className="border-t border-border mt-16 py-8 text-center text-xs text-gray-600">
            <p>MemeDay</p>
            <p className="mt-2 text-gray-700">
              We record anonymous product usage to see what people actually use. No
              advertising, no analytics cookies &mdash; browser local storage only.
            </p>
            <p className="mt-2">
              <a
                href="https://tally.so/r/VLaRb6"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-light hover:underline"
              >
                Feedback
              </a>
            </p>
          </footer>
        </SolanaWalletProvider>
        <Analytics />
      </body>
    </html>
  );
}
