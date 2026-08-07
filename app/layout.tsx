import type { Metadata } from "next";
import "./globals.css";
import { SolanaWalletProvider } from "@/components/WalletProvider";
import { Navbar } from "@/components/Navbar";
import { BagsToastContainer } from "@/components/BagsToast";
import { WalletAuthSync } from "@/components/WalletAuthSync";
import { AnalyticsInit } from "@/components/AnalyticsInit";
import { Analytics } from "@vercel/analytics/next";

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
        <SolanaWalletProvider>
          <WalletAuthSync />
          <AnalyticsInit />
          <Navbar />
          <main className="min-h-screen">{children}</main>
          <BagsToastContainer />
          <footer className="border-t border-border mt-16 py-8 text-center text-xs text-gray-600">
            <p>
              MemeDay &bull;{" "}
              <span className="text-accent-light">Solana</span>
            </p>
            <p className="mt-2 text-gray-700">
              We record anonymous product usage to see what people actually use. No
              advertising, no analytics cookies &mdash; browser local storage only.
            </p>
          </footer>
        </SolanaWalletProvider>
        <Analytics />
      </body>
    </html>
  );
}
