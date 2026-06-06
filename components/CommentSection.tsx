"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { DbComment } from "@/lib/types";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useAppStore } from "@/lib/store";
import { formatDistanceToNow } from "date-fns";

interface Props {
  memeId: string;
  initialComments: DbComment[];
}

export function CommentSection({ memeId, initialComments }: Props) {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { addToast } = useAppStore();
  const [body, setBody] = useState("");
  const [comments, setComments] = useState<DbComment[]>(initialComments);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) { setVisible(true); return; }
    if (!body.trim()) return;

    const wallet = publicKey.toBase58();
    const res = await fetch("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meme_id: memeId, user_wallet: wallet, text: body.trim() }),
    });

    if (!res.ok) {
      addToast("Failed to post comment.", "error");
      return;
    }

    const { comment } = await res.json();
    setComments((prev) => [...prev, comment]);
    setBody("");
    addToast("Comment posted!", "success");
  };

  return (
    <div id="comments" className="space-y-4">
      <h3 className="font-bold text-white text-lg">Comments ({comments.length})</h3>

      <form onSubmit={handleSubmit} className="flex gap-3">
        <div className="flex-1">
          <input
            type="text"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={publicKey ? "Add a comment…" : "Connect wallet to comment"}
            className="w-full bg-surface border border-border rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-accent placeholder:text-gray-600"
            onClick={() => !publicKey && setVisible(true)}
          />
        </div>
        <button
          type="submit"
          disabled={!body.trim()}
          className="px-4 py-3 bg-accent hover:bg-accent-light disabled:opacity-40 text-white rounded-xl transition-all hover:scale-105 active:scale-95"
        >
          <Send size={16} />
        </button>
      </form>

      {comments.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No comments yet. Be the first!</p>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => {
            const short = `${c.user_wallet.slice(0, 4)}…${c.user_wallet.slice(-4)}`;
            const avatar = `https://api.dicebear.com/8.x/bottts/svg?seed=${c.user_wallet}`;
            const fallback = `https://api.dicebear.com/8.x/identicon/png?seed=${encodeURIComponent(c.user_wallet)}&size=32&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`;
            return (
              <div key={c.id} className="flex gap-3">
                <img
                  src={avatar}
                  alt={short}
                  width={32}
                  height={32}
                  loading="lazy"
                  className="rounded-full bg-gray-800 flex-shrink-0 object-cover"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).src = fallback; }}
                />
                <div className="bg-surface border border-border/50 rounded-xl px-4 py-3 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-white font-mono">{short}</span>
                    <span className="text-xs text-gray-500">
                      {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="text-sm text-gray-300">{c.text}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
