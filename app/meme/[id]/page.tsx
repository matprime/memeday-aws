import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { getMemeById, getComments, getUserById } from "@/lib/db";
import { Creator } from "@/lib/types";
import { MemePageClient } from "@/components/MemePageClient";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";

interface Props {
  params: { id: string };
}

function buildStubCreator(userId: string, walletAddr?: string | null, bagsProjectId?: string | null): Creator {
  const seed = walletAddr ?? userId;
  return {
    id: userId,
    walletAddress: walletAddr ?? "",
    username: `${userId.slice(0, 4)}...${userId.slice(-4)}`,
    avatarUrl: `https://api.dicebear.com/8.x/identicon/png?seed=${encodeURIComponent(seed)}&size=80&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`,
    bio: "",
    bagsProjectId: bagsProjectId ?? "",
    memeCount: 0,
    joinedAt: new Date().toISOString(),
    token: {
      symbol: userId.slice(0, 5).toUpperCase(),
      name: "Creator Token",
      price: 0.01,
      priceChange24h: 0,
      holders: 0,
      totalVolume: 0,
      marketCap: 0,
      spiking: false,
    },
  };
}

export default async function MemePage({ params }: Props) {
  const [meme, comments] = await Promise.all([
    getMemeById(params.id),
    getComments(params.id),
  ]);
  if (!meme) notFound();

  const user = await getUserById(meme.creatorId);
  const creator = buildStubCreator(meme.creatorId, user?.walletAddr, user?.bagsProjectId);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <Link
        href="/browse"
        className="inline-flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-6 transition-colors"
      >
        <ArrowLeft size={16} />
        Back to browse
      </Link>

      <h1 className="text-2xl font-black text-white mb-4 leading-tight">{meme.caption}</h1>

      <div className="relative w-full aspect-video rounded-2xl overflow-hidden bg-gray-900 mb-6 border border-border">
        <Image
          src={meme.imageUrl}
          alt={meme.caption}
          fill
          className="object-contain"
          priority
        />
        {!!meme.nftMint && meme.listingPrice && (
          <div className="absolute top-4 right-4 bg-black/70 backdrop-blur-sm border border-accent/50 text-accent-light text-sm font-bold px-3 py-1.5 rounded-xl">
            NFT · {meme.listingPrice} SOL
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mb-6">
        <Link href={`/creator/${meme.creatorId}`} className="flex items-center gap-3 group">
          <Image
            src={creator.avatarUrl}
            alt={creator.username}
            width={44}
            height={44}
            className="rounded-full bg-gray-800 border-2 border-border group-hover:border-accent/50 transition-colors object-cover"
            unoptimized
          />
          <div>
            <p className="font-bold text-white font-mono group-hover:text-accent-light transition-colors">
              {creator.username}
            </p>
            <p className="text-xs text-gray-500">
              {formatDistanceToNow(new Date(meme.createdAt), { addSuffix: true })}
            </p>
          </div>
        </Link>

        {meme.nftMint ? (
          <a
            href={`https://explorer.solana.com/address/${meme.nftMint}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-accent-light border border-accent/40 bg-accent/10 hover:bg-accent/20 px-3 py-2 rounded-lg transition-colors font-bold"
          >
            <ExternalLink size={12} />
            NFT · View on Solana
          </a>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-gray-500 border border-border/60 bg-bg/60 px-3 py-2 rounded-lg font-semibold">
            Standard Meme
          </span>
        )}
      </div>

      <MemePageClient meme={meme} creator={creator} initialComments={comments} />
    </div>
  );
}
