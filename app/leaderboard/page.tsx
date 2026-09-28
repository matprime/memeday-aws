import {
  getLeaderboardCounts,
  getMemesByCreator,
  getPointsLeaderboardRows,
  getUsersByIds,
  type PointsPeriod,
} from "@/lib/db";
import { MOCK_CREATORS, MOCK_MEMES, creatorFromDbUser } from "@/lib/data";
import { Creator } from "@/lib/types";
import { LeaderboardClient, type PointsRow } from "./LeaderboardClient";

// Real users only, no MOCK_CREATORS (KAN-101) — the points program only means
// something for accounts that can actually earn, unlike the demo-data-backed
// Volume/Meme Count tabs above.
async function buildPointsRows(period: PointsPeriod): Promise<PointsRow[]> {
  try {
    return await getPointsLeaderboardRows(period);
  } catch {
    return [];
  }
}

type DisplayMeme = { id: string; imageUrl: string; caption: string; isNFT: boolean };

// Leaderboard counts, their creators' user records (one batched read, not one
// GetItem per creator), and each creator's memes (run concurrently, not one
// creator at a time), pulled out so it can run alongside the points queries
// below instead of after them.
async function buildCreatorData(): Promise<{
  dbCreators: Creator[];
  memesMap: Record<string, DisplayMeme[]>;
}> {
  const memesMap: Record<string, DisplayMeme[]> = {};
  for (const meme of MOCK_MEMES) {
    if (!memesMap[meme.creatorId]) memesMap[meme.creatorId] = [];
    memesMap[meme.creatorId].push({
      id: meme.id,
      imageUrl: meme.imageUrl,
      caption: meme.title,
      isNFT: meme.isNFT,
    });
  }

  let dbCreators: Creator[] = [];
  try {
    const counts = await getLeaderboardCounts();
    const users = await getUsersByIds(counts.map((c) => c.creatorId));
    dbCreators = counts
      .map((c) => {
        const user = users.get(c.creatorId);
        if (!user) return null;
        return creatorFromDbUser({ ...user, memeCount: c.memeCount, joinedAt: user.createdAt });
      })
      .filter((c): c is Creator => c !== null);

    const memesByCreator = await Promise.all(
      dbCreators.map((creator) => getMemesByCreator(creator.id).catch(() => []))
    );
    dbCreators.forEach((creator, i) => {
      const memes = memesByCreator[i];
      if (memes.length > 0) {
        memesMap[creator.id] = memes.map((m) => ({
          id: m.id,
          imageUrl: m.imageUrl,
          caption: m.caption,
          isNFT: !!m.nftMint,
        }));
      }
    });
  } catch {
    // DB unavailable, fall through to mock-only
  }

  return { dbCreators, memesMap };
}

export default async function LeaderboardPage() {
  const [{ dbCreators, memesMap }, pointsByDay, pointsByWeek, pointsByAllTime] =
    await Promise.all([
      buildCreatorData(),
      buildPointsRows("day"),
      buildPointsRows("week"),
      buildPointsRows("all"),
    ]);

  // Merge: mock creators first, then real users (skip any that collide by id)
  const mockIds = new Set(MOCK_CREATORS.map((c) => c.id));
  const merged: Creator[] = [
    ...MOCK_CREATORS,
    ...dbCreators.filter((c) => !mockIds.has(c.id)),
  ];

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
      pointsRows={{ day: pointsByDay, week: pointsByWeek, all: pointsByAllTime }}
    />
  );
}
