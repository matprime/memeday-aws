import { getLeaderboard, getUsersByIds, getMemesByCreator } from "@/lib/db";
import { MOCK_CREATORS, MOCK_MEMES, creatorFromDbUser } from "@/lib/data";
import { Creator } from "@/lib/types";
import { LeaderboardClient } from "./LeaderboardClient";

export default async function LeaderboardPage() {
  let dbCreators: Creator[] = [];

  try {
    // 2 DB calls instead of 1 + N: leaderboard view + batch user fetch
    const entries = await getLeaderboard();
    const users = await getUsersByIds(entries.map((e) => e.creatorId));
    const memeCountById = Object.fromEntries(entries.map((e) => [e.creatorId, e.memeCount]));

    dbCreators = users.map((user) =>
      creatorFromDbUser({
        ...user,
        memeCount: memeCountById[user.userId] ?? 0,
        joinedAt: user.createdAt,
      })
    );
  } catch {
    // DB unavailable — fall through to mock-only
  }

  // Merge: mock creators first, then real users (skip collisions by id)
  const mockIds = new Set(MOCK_CREATORS.map((c) => c.id));
  const merged: Creator[] = [
    ...MOCK_CREATORS,
    ...dbCreators.filter((c) => !mockIds.has(c.id)),
  ];

  // Build memes map for creator modal
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

  const creatorsByVolume = [...merged].sort((a, b) => b.token.totalVolume - a.token.totalVolume);
  const creatorsByMemes = [...merged].sort((a, b) => b.memeCount - a.memeCount);

  return (
    <LeaderboardClient
      creatorsByVolume={creatorsByVolume}
      creatorsByMemes={creatorsByMemes}
      memesMap={memesMap}
    />
  );
}
