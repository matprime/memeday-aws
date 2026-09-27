import {
  getLeaderboardCounts,
  getMemesByCreator,
  getUserById,
  getPointsLeaderboard,
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
    const entries = await getPointsLeaderboard(period);
    const users = await getUsersByIds(entries.map((e) => e.userId));
    return entries.map((e) => ({
      userId: e.userId,
      displayName: users.get(e.userId)?.displayName ?? e.userId.slice(0, 8),
      points: e.points,
    }));
  } catch {
    return [];
  }
}

export default async function LeaderboardPage() {
  // Fetch creator meme counts from the leaderboard materialized view, then
  // BatchGet the corresponding user records.
  let dbCreators: Creator[] = [];
  try {
    const counts = await getLeaderboardCounts();
    const users = await Promise.all(counts.map((c) => getUserById(c.creatorId)));
    dbCreators = counts
      .map((c, i) => {
        const user = users[i];
        if (!user) return null;
        return creatorFromDbUser({ ...user, memeCount: c.memeCount, joinedAt: user.createdAt });
      })
      .filter((c): c is Creator => c !== null);
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

  const [pointsByDay, pointsByWeek, pointsByAllTime] = await Promise.all([
    buildPointsRows("day"),
    buildPointsRows("week"),
    buildPointsRows("all"),
  ]);

  return (
    <LeaderboardClient
      creatorsByVolume={creatorsByVolume}
      creatorsByMemes={creatorsByMemes}
      memesMap={memesMap}
      pointsRows={{ day: pointsByDay, week: pointsByWeek, all: pointsByAllTime }}
    />
  );
}
