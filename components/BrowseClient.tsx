"use client";

import { useEffect } from "react";
import Link from "next/link";
import { DbMeme, Tab } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { MemeCard } from "./MemeCard";

const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This Week" },
  { id: "all", label: "All Memes" },
];

interface Props {
  memes: DbMeme[];
  range: Tab;
  nextCursor: string | null;
}

export function BrowseClient({ memes, range, nextCursor }: Props) {
  const { cognitoToken, reportedMemes, hydrateReportedMemes } = useAppStore();

  useEffect(() => {
    hydrateReportedMemes(cognitoToken, memes.map((m) => m.id));
    // Only re-hydrate when the set of visible memes or the session changes,
    // not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cognitoToken, memes]);

  const filtered = memes.filter((m) => !reportedMemes.has(m.id));

  return (
    <>
      <div className="flex gap-2 mb-8 bg-surface border border-border rounded-xl p-1.5 w-fit">
        {TABS.map(({ id, label }) => (
          <Link
            key={id}
            href={`/browse?range=${id}`}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
              range === id ? "bg-accent text-white shadow" : "text-gray-400 hover:text-white"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-5xl mb-4">🫙</p>
          <p className="font-semibold text-lg">No memes yet for this period</p>
          <p className="text-sm mt-1">Be the first to post today!</p>
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map((m) => (
              <MemeCard key={m.id} meme={m} commentCount={m.commentCount} />
            ))}
          </div>
          {nextCursor && (
            <div className="flex justify-center mt-8">
              <Link
                href={`/browse?range=${range}&cursor=${encodeURIComponent(nextCursor)}`}
                className="px-5 py-2 rounded-lg text-sm font-semibold bg-surface border border-border text-gray-300 hover:text-white transition-all"
              >
                Next page
              </Link>
            </div>
          )}
        </>
      )}
    </>
  );
}
