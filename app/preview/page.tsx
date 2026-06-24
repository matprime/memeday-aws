"use client";

import { MemeCard } from "@/components/MemeCard";
import { DbMeme } from "@/lib/types";

// Standalone preview: hardcoded sample props only.
// No data fetching, AWS SDK, DynamoDB, or Cognito logic is used here.
const standardMeme: DbMeme = {
  id: "meme-0001",
  creatorId: "8xQmZc4P9rTnbVfKwLdY2hJ6gAeRsUoXpC1nM3vQwEr",
  ownerId: "8xQmZc4P9rTnbVfKwLdY2hJ6gAeRsUoXpC1nM3vQwEr",
  creatorWalletAddr: "8xQmZc4P9rTnbVfKwLdY2hJ6gAeRsUoXpC1nM3vQwEr",
  s3Key: "memes/meme-0001.png",
  imageUrl: "/distracted-boyfriend-meme.png",
  caption: "When the code compiles on the first try and you don't trust it",
  nftMint: "Mint22222222222222222222222222222222222222",
  status: "listed",
  listingPrice: 1.2,
  likeCount: 1284,
  commentCount: 37,
  score: 1284,
  createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
};

const featuredNftMeme: DbMeme = {
  id: "meme-0002",
  creatorId: "5kRtBn2Wq7yUvHsLpXz9cFdM4gJ1aEoQ6nT3vYwZbXr",
  ownerId: "5kRtBn2Wq7yUvHsLpXz9cFdM4gJ1aEoQ6nT3vYwZbXr",
  creatorWalletAddr: "5kRtBn2Wq7yUvHsLpXz9cFdM4gJ1aEoQ6nT3vYwZbXr",
  s3Key: "memes/meme-0002.png",
  imageUrl: "/this-is-fine-dog-fire-meme.png",
  caption: "Shipping to prod on a Friday afternoon",
  nftMint: "Mint11111111111111111111111111111111111111",
  status: "listed",
  listingPrice: 2.5,
  likeCount: 8421,
  commentCount: 192,
  score: 8421,
  createdAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
};

export default function MemeCardPreviewPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-black text-white">MemeCard Preview</h1>
        <p className="text-sm text-gray-400">
          Standalone render with hardcoded sample props — no backend, AWS, or auth.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-400">Featured (NFT, listed)</h2>
        <div className="max-w-xl">
          <MemeCard meme={featuredNftMeme} featured commentCount={featuredNftMeme.commentCount} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-400">Standard</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <MemeCard meme={standardMeme} commentCount={standardMeme.commentCount} />
        </div>
      </section>
    </div>
  );
}
