"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DbMeme, DbComment, Creator } from "@/lib/types";
import { MemeActionBar } from "./MemeActionBar";
import { CommentSection } from "./CommentSection";
import { EVENTS, track } from "@/lib/analytics";

interface Props {
  meme: DbMeme;
  creator: Creator;
  initialComments: DbComment[];
}

export function MemePageClient({ meme, creator, initialComments }: Props) {
  const [commentCount, setCommentCount] = useState(initialComments.length);
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get("ref") !== "share") return;
    const channel = searchParams.get("ch");
    if (!channel) return;

    // Once per session per meme+channel, so refreshing the landing page
    // doesn't inflate visit_from_share against a single share_clicked.
    const dedupeKey = `visit_from_share_${meme.id}_${channel}`;
    if (sessionStorage.getItem(dedupeKey)) return;
    sessionStorage.setItem(dedupeKey, "1");

    track(EVENTS.visitFromShare, { memeId: meme.id, channel });
  }, [searchParams, meme.id]);

  return (
    <>
      <MemeActionBar meme={meme} creator={creator} commentCount={commentCount} />
      <div className="mt-8 pt-8 border-t border-border">
        <CommentSection
          memeId={meme.id}
          initialComments={initialComments}
          onCommentAdded={() => setCommentCount((c) => c + 1)}
        />
      </div>
    </>
  );
}
