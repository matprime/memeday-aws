import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { getMemeById, getComments, getUserByWallet } from "@/lib/db";
import { Creator } from "@/lib/types";
import { CommentSection } from "@/components/CommentSection";
import { MemeActionBar } from "@/components/MemeActionBar";
import { ArrowLeft, ExternalLink, Flame } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";

interface Props {
  params: { id: string };
}

function buildStubCreator(wallet: string, bagsProjectId?: string | null): Creator {
  return {
    id: wallet,
    walletAddress: wallet,
    username: `${wallet.slice(0, 4)}...${wallet.slice(-4)}`,
    avatarUrl: `https://api.dicebear.com/8.x/identicon/png?seed=${encodeURIComponent(wallet)}&size=80&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`,
    bio: "",
    bagsProjectId: bagsProjectId ?? "",
    memeCount: 0,
    joinedAt: new Date().toISOString(),
    token: {
      symbol: wallet.slice(0, 5).toUpperCase(),
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

  const user = await getUserByWallet(meme.creator_wallet);
  const creator = buildStubCreator(meme.creator_wallet, user?.bags_project_id);

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
          src={meme.image_url}
          alt={meme.caption}
          fill
          className="object-contain"
          priority
        />
        {meme.is_nft && meme.price && (
          <div className="absolute top-4 right-4 bg-black/70 backdrop-blur-sm border border-accent/50 text-accent-light text-sm font-bold px-3 py-1.5 rounded-xl">
            NFT · {meme.price} SOL
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mb-6">
        <Link href={`/creator/${meme.creator_wallet}`} className="flex items-center gap-3 group">
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
              {formatDistanceToNow(new Date(meme.created_at), { addSuffix: true })}
            </p>
          </div>
        </Link>

        {meme.is_nft && meme.mint_address && (
          <a
            href={`https://explorer.solana.com/address/${meme.mint_address}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-accent-light border border-border hover:border-accent/50 px-3 py-2 rounded-lg transition-colors"
          >
            <ExternalLink size={12} />
            View NFT on Solana
          </a>
        )}
      </div>

      <MemeActionBar meme={meme} creator={creator} commentCount={comments.length} />

      <div className="mt-8 pt-8 border-t border-border">
        <CommentSection memeId={meme.id} initialComments={comments} />
      </div>
    </div>
  );
}
