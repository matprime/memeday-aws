import type { Metadata } from "next";

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
const DEFAULT_IMAGE = `${APP_URL}/api/og-default`;
const DEFAULT_TITLE = "MemeDay — Creator Economy on Solana";
const DEFAULT_DESCRIPTION =
  "Post memes, earn creator tokens, and invest in your favorite meme creators via Bags.";

export const metadata: Metadata = {
  title: DEFAULT_TITLE,
  description: DEFAULT_DESCRIPTION,
  openGraph: {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: [DEFAULT_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: [DEFAULT_IMAGE],
  },
};

export default function MemeNotFound() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-16 text-center">
      <h1 className="text-2xl font-black text-white mb-2">Meme not found</h1>
      <p className="text-gray-400">This meme doesn&apos;t exist or was removed.</p>
    </div>
  );
}
