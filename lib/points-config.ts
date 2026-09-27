// Single source of truth for point values and daily caps (KAN-101). Nothing
// else should hardcode a point value or a cap — add or tune a value here
// only. Kept separate from lib/rate-limit-config.ts: these bound how many
// points a user can earn per day, not how many requests they can make.

// How long after a USER# item is created a referrer can still attach
// (POST /api/users writes referredBy, gated by this window in lib/db.ts's
// attachReferrer). A window, not "any time", so a stale ?refBy sitting in a
// browser's localStorage for months can't attach to an account it never
// actually referred.
export const REFERRAL_ATTACH_WINDOW_HOURS = 24;

// Comments shorter than this earn nothing for either side (KAN-101): a
// one-character "lol" is not the engagement this program is meant to reward.
export const MIN_COMMENT_LENGTH_FOR_POINTS = 10;

// Daily counters (PK POINTS#<userId>, SK DAY#<yyyy-mm-dd>#<action>) only need
// to survive long enough to enforce "today"'s cap. 2 days of TTL headroom is
// the same buffer lib/rate-limit.ts uses for its own window counters.
export const DAILY_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

// LB#DAY#<yyyy-mm-dd> period-total items (unlike LB#WEEK#/LB#ALLTIME) are
// only ever queried for "today" — without a TTL one small item per active
// earner would accumulate forever. 8 days per the KAN-101 ticket comment.
export const DAY_LEADERBOARD_TTL_SECONDS = 8 * 24 * 60 * 60;

export type PointsAction =
  | "UPLOAD"
  | "RECEIVE_LIKE"
  | "GIVE_LIKE"
  | "GIVE_COMMENT"
  | "RECEIVE_COMMENT"
  | "REFERRAL";

export interface PointsActionDef {
  points: number;
  // "points": the daily cap bounds total points awarded for this action.
  // "count": the daily cap bounds the number of awards, regardless of points.
  dailyCap: { unit: "points" | "count"; max: number };
}

export const POINTS_ACTIONS: Record<PointsAction, PointsActionDef> = {
  UPLOAD: { points: 10, dailyCap: { unit: "count", max: 3 } },
  RECEIVE_LIKE: { points: 2, dailyCap: { unit: "points", max: 100 } },
  GIVE_LIKE: { points: 1, dailyCap: { unit: "points", max: 20 } },
  GIVE_COMMENT: { points: 3, dailyCap: { unit: "count", max: 10 } },
  RECEIVE_COMMENT: { points: 1, dailyCap: { unit: "points", max: 50 } },
  REFERRAL: { points: 20, dailyCap: { unit: "count", max: 3 } },
};

// Shared by lib/db.ts (leaderboard reads) and lambdas/stream-handler (award
// writes) so both sides bucket a timestamp into the exact same period key.
// UTC throughout — never the host's local timezone, or a Lambda and a
// developer's laptop could disagree on which day/week a point landed in.

export function utcDateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Standard ISO 8601 week algorithm (Monday-start weeks, week 1 = the week
// containing the year's first Thursday), computed purely off UTC getters.
export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Monday=1 .. Sunday=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
