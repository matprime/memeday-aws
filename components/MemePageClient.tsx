"use client";

import { useState } from "react";
import { DbMeme, DbComment, Creator } from "@/lib/types";
import { MemeActionBar } from "./MemeActionBar";
import { CommentSection } from "./CommentSection";

interface Props {
  meme: DbMeme;
  creator: Creator;
  initialComments: DbComment[];
}

export function MemePageClient({ meme, creator, initialComments }: Props) {
  const [commentCount, setCommentCount] = useState(initialComments.length);

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
