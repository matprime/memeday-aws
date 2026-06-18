"use client";

import { useState } from "react";
import { DbMeme, Tab } from "@/lib/types";
import { MemeCard } from "./MemeCard";

const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This Week" },
  { id: "all", label: "All Memes" },
];

interface Props {
  memes: DbMeme[];
}

export function BrowseClient({ memes }: Props) {
  const [tab, setTab] = useState<Tab>("today");

  const filtered = memes.filter((m) => {
    const posted = new Date(m.createdAt);
    if (tab === "today") {
      const today = new Date();
      return posted.toDateString() === today.toDateString();
    }
    if (tab === "week") {
      return posted >= new Date(Date.now() - 7 * 86400000);
    }
    return true;
  });

  return (
    <>
      <div className="flex gap-2 mb-8 bg-surface border border-border rounded-xl p-1.5 w-fit">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
              tab === id ? "bg-accent text-white shadow" : "text-gray-400 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-5xl mb-4">🫙</p>
          <p className="font-semibold text-lg">No memes yet for this period</p>
          <p className="text-sm mt-1">Be the first to post today!</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((m) => (
            <MemeCard key={m.id} meme={m} commentCount={m.commentCount} />
          ))}
        </div>
      )}
    </>
  );
}
