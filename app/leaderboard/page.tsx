import { getAllUsers, getMemesByCreator } from "@/lib/db";
import { MOCK_CREATORS, MOCK_MEMES, creatorFromDbUser } from "@/lib/data";
import { Creator } from "@/lib/types";
import { LeaderboardClient } from "./LeaderboardClient";

export default async function LeaderboardPage() {
  // Fetch real app users and their meme counts
  let dbCreators: Creator[] = [];
  try {
    const users = await getAllUsers();
    dbCreators = await Promise.all(
      users.map(async (user) => {
        const memes = await getMemesByCreator(user.userId);
        return creatorFromDbUser({
          ...user,
          memeCount: memes.length,
          joinedAt: user.createdAt,
        });
      })
    );
  } catch {
    // DB unavailable — fall through to mock-only
  }

  // Merge: mock creators first, then real users (skip any that collide by id)
  const mockIds = new Set(MOCK_CREATORS.map((c) => c.id));
  const merged: Creator[] = [
    ...MOCK_CREATORS,
    ...dbCreators.filter((c) => !mockIds.has(c.id)),
  ];

  // Build a unified memes map for the modal: { creatorId -> [{id, imageUrl, caption, isNFT}] }
  const memesMap: Record<string, Array<{ id: string; imageUrl: string; caption: string; isNFT: boolean }>> = {};

  for (const meme of MOCK_MEMES) {
    if (!memesMap[meme.creatorId]) memesMap[meme.creatorId] = [];
    memesMap[meme.creatorId].push({
      id: meme.id,
      imageUrl: meme.imageUrl,
      caption: meme.title,
      isNFT: meme.isNFT,
    });
  }

  for (const creator of dbCreators) {
    try {
      const memes = await getMemesByCreator(creator.id);
      if (memes.length > 0) {
        memesMap[creator.id] = memes.map((m) => ({
          id: m.id,
          imageUrl: m.imageUrl,
          caption: m.caption,
          isNFT: !!m.nftMint,
        }));
      }
    } catch {
      // skip
    }
  }

  const creatorsByVolume = [...merged].sort(
    (a, b) => b.token.totalVolume - a.token.totalVolume
  );
  const creatorsByMemes = [...merged].sort(
    (a, b) => b.memeCount - a.memeCount
  );

  return (
    <LeaderboardClient
      creatorsByVolume={creatorsByVolume}
      creatorsByMemes={creatorsByMemes}
      memesMap={memesMap}
    />
  );
}
