import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { getUserByWallet, getMemesByCreator } from "@/lib/db";
import { MemeCard } from "@/components/MemeCard";
import { ImageIcon, Zap, BarChart3 } from "lucide-react";

export const dynamic = "force-dynamic";

interface Props {
  params: { id: string };
}

export default async function CreatorPage({ params }: Props) {
  const wallet = decodeURIComponent(params.id);
  const [user, memes] = await Promise.all([
    getUserByWallet(wallet),
    getMemesByCreator(wallet),
  ]);

  if (!user && memes.length === 0) notFound();

  const username = `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
  const avatarUrl = `https://api.dicebear.com/8.x/bottts/svg?seed=${wallet}`;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="bg-surface border border-border rounded-2xl p-6 mb-8">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <Image
              src={avatarUrl}
              alt={username}
              width={72}
              height={72}
              className="rounded-full bg-gray-800 border-2 border-border"
            />
            <div>
              <h1 className="text-2xl font-black text-white font-mono mb-1">{username}</h1>
              <p className="text-xs text-gray-500 font-mono break-all">{wallet}</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-6 pt-6 border-t border-border">
          <div className="bg-bg/60 border border-border/50 rounded-xl p-4">
            <ImageIcon size={16} className="text-gray-500 mb-2" />
            <p className="text-lg font-bold text-white">{memes.length}</p>
            <p className="text-xs text-gray-500 mt-0.5">Memes Posted</p>
          </div>
          <div className="bg-bg/60 border border-border/50 rounded-xl p-4">
            <BarChart3 size={16} className="text-gray-500 mb-2" />
            <p className="text-lg font-bold text-white">{user?.cred_score ?? 0}</p>
            <p className="text-xs text-gray-500 mt-0.5">Cred Score</p>
          </div>
          {user?.bags_project_id && (
            <div className="bg-bg/60 border border-border/50 rounded-xl p-4">
              <Zap size={16} className="text-bags mb-2" />
              <p className="text-sm font-mono text-bags truncate">{user.bags_project_id}</p>
              <p className="text-xs text-gray-500 mt-0.5">Bags Project</p>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <ImageIcon size={18} className="text-accent-light" />
        <h2 className="text-xl font-black text-white">Memes by {username}</h2>
      </div>

      {memes.length === 0 ? (
        <p className="text-gray-500 text-center py-12">No memes yet.</p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {memes.map((m) => (
            <MemeCard key={m.id} meme={m} />
          ))}
        </div>
      )}
    </div>
  );
}
