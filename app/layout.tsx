import type { Metadata } from "next";
import "./globals.css";
import { SolanaWalletProvider } from "@/components/WalletProvider";
import { Navbar } from "@/components/Navbar";
import { BagsToastContainer } from "@/components/BagsToast";
import { WalletAuthSync } from "@/components/WalletAuthSync";

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
          <Navbar />
          <main className="min-h-screen">{children}</main>
          <BagsToastContainer />
          <footer className="border-t border-border mt-16 py-8 text-center text-xs text-gray-600">
            <p>
              MemeDay &bull;{" "}
              <span className="text-accent-light">Solana</span>
            </p>
          </footer>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
