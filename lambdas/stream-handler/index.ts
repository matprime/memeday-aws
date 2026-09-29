import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  QueryCommand,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { DynamoDBStreamHandler, DynamoDBRecord } from "aws-lambda";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  POINTS_ACTIONS,
  MIN_COMMENT_LENGTH_FOR_POINTS,
  DAILY_COUNTER_TTL_SECONDS,
  DAY_LEADERBOARD_TTL_SECONDS,
  utcDateKey,
  isoWeekKey,
  type PointsAction,
} from "../../lib/points-config";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// Exported so tests can stub .send instead of hitting live S3/CloudFront/SNS,
// same pattern as lambdas/moderation-handler's exported rekognition client.
export const s3 = new S3Client({});
export const cloudfront = new CloudFrontClient({});
export const sns = new SNSClient({});
export const cloudwatch = new CloudWatchClient({});
// Exported so points tests can stub .send to inject a TransactionConflict on
// one attempt and observe the retry, same reason s3/cloudfront/sns are exported.
export { docClient };

// No fallback. The old "MemeDay" table survives the rename as an orphan, so a
// missing env var would silently write to a dead table rather than fail. CDK
// always injects this, so the throw only catches misconfiguration.
const tableName = process.env.DYNAMODB_TABLE_NAME;
if (!tableName) {
  throw new Error("Missing DYNAMODB_TABLE_NAME");
}
const TABLE = tableName;

// Read lazily, not at module load: only the takedown path needs these, and
// throwing here would break every INSERT/MODIFY/REMOVE test that never
// exercises a takedown.
function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} not set`);
  return v;
}

// Zero-pad to 15 digits so DynamoDB lexicographic sort == numeric sort for scores.
function padScore(n: number): string {
  return Math.max(0, n).toString().padStart(15, "0");
}

// Flagged-for-review (KAN-44) and taken-down (KAN-43) memes must never reach
// FEED#GLOBAL / GSI3. Every other status (active, listed, sold, and the
// pre-KAN-44 default of undefined) is feed-eligible.
function isCleanStatus(status: unknown): boolean {
  return status !== "pending_review" && status !== "removed";
}

// ---------------------------------------------------------------------------
// Points & leaderboard (KAN-101)
// ---------------------------------------------------------------------------

// Same "which stack does this instance actually write to" definition as
// lib/rate-limit.ts's STAGE — the table name is the only honest signal here.
const STAGE = TABLE === "MemeDayProd" ? "prod" : "dev";

// Fire-and-forget, matching lib/rate-limit.ts's emitCounterFailureMetric in
// spirit: a broken metric publish must never be the reason points processing
// fails. No waitUntil here — unlike a Vercel function, a Lambda invocation
// doesn't get frozen the instant a response is sent, so a plain await is
// enough to guarantee delivery before the handler returns.
async function emitPointsAwardFailureMetric(): Promise<void> {
  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: "MemeDay",
        MetricData: [
          {
            MetricName: "PointsAwardFailure",
            Value: 1,
            Unit: "Count",
            Dimensions: [{ Name: "Stage", Value: STAGE }],
          },
        ],
      })
    );
  } catch (err) {
    console.error("failed to publish PointsAwardFailure metric", err);
  }
}

// Wraps one points-path operation so a failure there can never break the
// feed/leaderboard/report handling around it (mirrors the existing per-record
// try/catch, which swallows errors so Streams retries never fire). Anything
// caught here is a genuine infra fault, not a business outcome — expected
// outcomes (duplicate award, cap hit) are handled inside awardPoints itself
// and never throw.
async function safePointsOp(op: () => Promise<void>, label: string): Promise<void> {
  try {
    await op();
  } catch (err) {
    console.error(`points operation failed (${label}):`, err);
    await emitPointsAwardFailureMetric();
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string })?.name === "ConditionalCheckFailedException";
}

function isTransactionCancelled(err: unknown): boolean {
  return (err as { name?: string })?.name === "TransactionCanceledException";
}

interface CancellationReason {
  Code?: string;
  Message?: string;
}

function cancellationReasons(err: unknown): CancellationReason[] {
  return (err as { CancellationReasons?: CancellationReason[] })?.CancellationReasons ?? [];
}

// A cancelled transaction whose every reason is "None" (that particular item
// wasn't the problem) or "ConditionalCheckFailed" (the award already exists,
// or the daily cap rejected it) is an expected business outcome — see
// awardPoints's caller-facing comment. Anything else in the reasons array
// (TransactionConflict from a genuinely concurrent writer touching the same
// item, ProvisionedThroughputExceeded, ValidationError, ...) is a real fault
// worth retrying, not a "nothing to award" case.
function isExpectedCancellation(err: unknown): boolean {
  if (!isTransactionCancelled(err)) return false;
  const reasons = cancellationReasons(err);
  return (
    reasons.length > 0 &&
    reasons.every((r) => !r.Code || r.Code === "None" || r.Code === "ConditionalCheckFailed")
  );
}

const MAX_TRANSACT_ATTEMPTS = 3;
const RETRY_BASE_MS = 20;

// Exponential backoff with jitter, short on purpose — this is retrying a
// same-request DynamoDB conflict inside a Streams handler with its own
// timeout, not backing off from a rate limit.
function jitteredBackoffMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * RETRY_BASE_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Replay-safe step required after every points write, whether the write just
// happened or was rejected as a duplicate/cap hit: GSI3SK doesn't update
// itself when `points` changes via ADD, so it has to be resynced from a fresh
// read every time. Conditioned on the exact value just read so a concurrent
// award racing this one can't clobber a fresher GSI3SK with a stale one — on
// a lost race this just no-ops, since the winner's own refresh already covers
// the value that matters.
async function refreshGsi3Sk(pk: string, sk: string): Promise<void> {
  const result = await docClient.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
  if (!result.Item) return;
  const points = (result.Item.points as number) ?? 0;
  const userId = (sk as string).slice("USER#".length);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: sk },
        UpdateExpression: "SET GSI3SK = :gsi3sk",
        ConditionExpression: "points = :points",
        ExpressionAttributeValues: {
          ":gsi3sk": `${padScore(points)}#${userId}`,
          ":points": points,
        },
      })
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }
}

async function refreshPeriodTotals(userId: string, dayKey: string, weekKey: string): Promise<void> {
  await Promise.all([
    refreshGsi3Sk(`LB#DAY#${dayKey}`, `USER#${userId}`),
    refreshGsi3Sk(`LB#WEEK#${weekKey}`, `USER#${userId}`),
    refreshGsi3Sk("LB#ALLTIME", `USER#${userId}`),
  ]);
}

// The one entry point for every points award (KAN-101). `createdAt` is the
// SOURCE item's timestamp (the meme/like/comment that earned the points, or
// the qualifying meme for a referral) — not "now" — so a delayed Streams
// retry still attributes to the day/week the thing actually happened in, and
// so reversal (see reverseAward below) can recompute the identical bucket
// keys without having to store them on the award item.
async function awardPoints(params: {
  earnerId: string;
  action: PointsAction;
  awardSk: string;
  sourceId: string;
  createdAt: string;
  qualifyingMemeId?: string;
}): Promise<void> {
  const def = POINTS_ACTIONS[params.action];
  const sourceDate = new Date(params.createdAt);
  const dayKey = utcDateKey(sourceDate);
  const weekKey = isoWeekKey(sourceDate);
  const userSk = `USER#${params.earnerId}`;

  const awardItem: Record<string, unknown> = {
    PK: `POINTS#${params.earnerId}`,
    SK: params.awardSk,
    points: def.points,
    action: params.action,
    sourceId: params.sourceId,
    week: weekKey,
    createdAt: new Date().toISOString(),
  };
  if (params.qualifyingMemeId) awardItem.qualifyingMemeId = params.qualifyingMemeId;

  const inc = def.dailyCap.unit === "points" ? def.points : 1;
  const capMinusInc = def.dailyCap.max - inc;

  const transactItems = [
    {
      Put: {
        TableName: TABLE,
        Item: awardItem,
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    {
      Update: {
        TableName: TABLE,
        Key: { PK: `POINTS#${params.earnerId}`, SK: `DAY#${dayKey}#${params.action}` },
        UpdateExpression: "ADD used :inc SET expiresAt = if_not_exists(expiresAt, :ttl)",
        ConditionExpression: "attribute_not_exists(used) OR used <= :capMinusInc",
        ExpressionAttributeValues: {
          ":inc": inc,
          ":capMinusInc": capMinusInc,
          ":ttl": Math.floor(Date.now() / 1000) + DAILY_COUNTER_TTL_SECONDS,
        },
      },
    },
    {
      Update: {
        TableName: TABLE,
        Key: { PK: `LB#DAY#${dayKey}`, SK: userSk },
        UpdateExpression:
          "ADD points :pts SET GSI3PK = if_not_exists(GSI3PK, :pk), userId = if_not_exists(userId, :uid), expiresAt = if_not_exists(expiresAt, :ttl)",
        ExpressionAttributeValues: {
          ":pts": def.points,
          ":pk": `LB#DAY#${dayKey}`,
          ":uid": params.earnerId,
          ":ttl": Math.floor(Date.now() / 1000) + DAY_LEADERBOARD_TTL_SECONDS,
        },
      },
    },
    {
      Update: {
        TableName: TABLE,
        Key: { PK: `LB#WEEK#${weekKey}`, SK: userSk },
        UpdateExpression:
          "ADD points :pts SET GSI3PK = if_not_exists(GSI3PK, :pk), userId = if_not_exists(userId, :uid)",
        ExpressionAttributeValues: {
          ":pts": def.points,
          ":pk": `LB#WEEK#${weekKey}`,
          ":uid": params.earnerId,
        },
      },
    },
    {
      Update: {
        TableName: TABLE,
        Key: { PK: "LB#ALLTIME", SK: userSk },
        UpdateExpression:
          "ADD points :pts SET GSI3PK = if_not_exists(GSI3PK, :pk), userId = if_not_exists(userId, :uid)",
        ExpressionAttributeValues: {
          ":pts": def.points,
          ":pk": "LB#ALLTIME",
          ":uid": params.earnerId,
        },
      },
    },
  ];

  for (let attempt = 1; attempt <= MAX_TRANSACT_ATTEMPTS; attempt++) {
    try {
      await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
      break;
    } catch (err) {
      // Every reason in the cancellation is "the award already exists" or
      // "today's cap is already hit" — an expected business outcome, not a
      // fault. There is nothing to award, and the replay-safe step below
      // still needs to run.
      if (isExpectedCancellation(err)) break;
      // A genuine conflict (e.g. TransactionConflict from a concurrent writer
      // touching the same period-total item) or any other fault: retry a
      // couple of times with short jittered backoff before giving up and
      // letting safePointsOp's caller emit PointsAwardFailure.
      if (attempt === MAX_TRANSACT_ATTEMPTS) throw err;
      await sleep(jitteredBackoffMs(attempt));
    }
  }

  // Run even when the award above was a duplicate/cap-rejected — a no-op
  // re-write of the same value is harmless, and this is the only place
  // GSI3SK gets fixed up after an ADD.
  await refreshPeriodTotals(params.earnerId, dayKey, weekKey);
}

// Reverses one award: deletes the ledger row, subtracts its points back out
// of the day/week/all-time totals, and refreshes GSI3SK. Returns the deleted
// item (or null if there was nothing to reverse — the award never happened,
// e.g. it was rejected by a daily cap, or this is a second reversal attempt).
async function reverseAward(
  earnerId: string,
  awardSk: string,
  memeCreatedAt: string
): Promise<Record<string, unknown> | null> {
  const key = { PK: `POINTS#${earnerId}`, SK: awardSk };
  const existing = await docClient.send(new GetCommand({ TableName: TABLE, Key: key }));
  if (!existing.Item) return null;

  const points = (existing.Item.points as number) ?? 0;
  await docClient.send(new DeleteCommand({ TableName: TABLE, Key: key }));

  const dayKey = utcDateKey(new Date(memeCreatedAt));
  const weekKey = isoWeekKey(new Date(memeCreatedAt));
  const userSk = `USER#${earnerId}`;
  await Promise.all([
    docClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `LB#DAY#${dayKey}`, SK: userSk },
        UpdateExpression: "ADD points :neg",
        ExpressionAttributeValues: { ":neg": -points },
      })
    ),
    docClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `LB#WEEK#${weekKey}`, SK: userSk },
        UpdateExpression: "ADD points :neg",
        ExpressionAttributeValues: { ":neg": -points },
      })
    ),
    docClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: "LB#ALLTIME", SK: userSk },
        UpdateExpression: "ADD points :neg",
        ExpressionAttributeValues: { ":neg": -points },
      })
    ),
  ]);
  await refreshPeriodTotals(earnerId, dayKey, weekKey);
  return existing.Item as Record<string, unknown>;
}

// KAN-101 upload-award reversal: fired from the existing wasClean/!isClean
// MODIFY branch below. Daily counters are deliberately left untouched (see
// ARCHITECTURE.md) — only the ledger row and the period totals it fed move.
async function reverseUploadAward(creatorId: string, memeId: string, memeCreatedAt: string): Promise<void> {
  await reverseAward(creatorId, `AWARD#UPLOAD#${memeId}`, memeCreatedAt);
}

// Reverses the referrer's award only if it was actually earned by THIS meme
// (qualifyingMemeId match) — a referrer who already has a later qualifying
// meme on record, or no award at all, is untouched.
async function reverseReferralAwardIfQualifying(
  referredUserId: string,
  memeId: string,
  memeCreatedAt: string
): Promise<void> {
  const marker = await docClient.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${referredUserId}`, SK: "REFERREDBY" } })
  );
  const referrerId = marker.Item?.referrerId as string | undefined;
  if (!referrerId) return;

  const awardKey = { PK: `POINTS#${referrerId}`, SK: `AWARD#REFERRAL#${referredUserId}` };
  const existing = await docClient.send(new GetCommand({ TableName: TABLE, Key: awardKey }));
  if (!existing.Item || existing.Item.qualifyingMemeId !== memeId) return;

  await reverseAward(referrerId, `AWARD#REFERRAL#${referredUserId}`, memeCreatedAt);
}

// Fired only when `prevMemeCount` is 0 — i.e. the meme that was just adjusted
// into the leaderboard is this creator's first ever clean one. Looks up
// whether anyone referred this creator (POINTS#<creatorId>/REFERREDBY,
// written below by handleUserReferralMarker) and, if so, awards them.
async function maybeAwardReferral(referredUserId: string, memeId: string, memeCreatedAt: string): Promise<void> {
  const marker = await docClient.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `POINTS#${referredUserId}`, SK: "REFERREDBY" } })
  );
  const referrerId = marker.Item?.referrerId as string | undefined;
  if (!referrerId) return;

  await safePointsOp(
    () =>
      awardPoints({
        earnerId: referrerId,
        action: "REFERRAL",
        awardSk: `AWARD#REFERRAL#${referredUserId}`,
        sourceId: referredUserId,
        createdAt: memeCreatedAt,
        qualifyingMemeId: memeId,
      }),
    `referral for ${referrerId}`
  );
}

// LIKE# items (PK=MEME#<id>, SK=LIKE#<userId>) carry only createdAt — the
// creator and status live on the MEME# item, so this is a GetItem before
// anything else. Never fires for a self-like or a meme that isn't clean.
async function handleLikeAward(memeId: string, likerUserId: string, likeCreatedAt: string): Promise<void> {
  const memeResult = await docClient.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } })
  );
  const meme = memeResult.Item;
  if (!meme || !isCleanStatus(meme.status)) return;

  const creatorId = meme.creatorId as string;
  if (creatorId === likerUserId) return;

  await safePointsOp(
    () =>
      awardPoints({
        earnerId: likerUserId,
        action: "GIVE_LIKE",
        awardSk: `AWARD#GIVE_LIKE#${memeId}`,
        sourceId: memeId,
        createdAt: likeCreatedAt,
      }),
    `give_like by ${likerUserId} on ${memeId}`
  );
  await safePointsOp(
    () =>
      awardPoints({
        earnerId: creatorId,
        action: "RECEIVE_LIKE",
        awardSk: `AWARD#RECEIVE_LIKE#${memeId}#${likerUserId}`,
        sourceId: memeId,
        createdAt: likeCreatedAt,
      }),
    `receive_like for ${creatorId} on ${memeId}`
  );
}

// COMMENT# items carry the full comment (see lib/db.ts addComment). GIVE_COMMENT's
// award SK is keyed by memeId only (not commentId) — PK is already the commenter,
// so the conditional Put in awardPoints structurally enforces "one award per meme
// per user" without a separate check here. RECEIVE_COMMENT is keyed by memeId+commenterId
// for the same reason: one award per meme per commenter, not per comment.
async function handleCommentAward(comment: Record<string, unknown>): Promise<void> {
  const memeId = comment.memeId as string;
  const commenterId = comment.userId as string;
  const body = (comment.body as string | undefined) ?? "";
  const createdAt = comment.createdAt as string;

  if (body.length < MIN_COMMENT_LENGTH_FOR_POINTS) return;

  const memeResult = await docClient.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } })
  );
  const meme = memeResult.Item;
  if (!meme || !isCleanStatus(meme.status)) return;

  const creatorId = meme.creatorId as string;
  if (creatorId === commenterId) return;

  await safePointsOp(
    () =>
      awardPoints({
        earnerId: commenterId,
        action: "GIVE_COMMENT",
        awardSk: `AWARD#GIVE_COMMENT#${memeId}`,
        sourceId: memeId,
        createdAt,
      }),
    `give_comment by ${commenterId} on ${memeId}`
  );
  await safePointsOp(
    () =>
      awardPoints({
        earnerId: creatorId,
        action: "RECEIVE_COMMENT",
        awardSk: `AWARD#RECEIVE_COMMENT#${memeId}#${commenterId}`,
        sourceId: memeId,
        createdAt,
      }),
    `receive_comment for ${creatorId} on ${memeId}`
  );
}

// Writes the REFERREDBY marker the first time a USER# item's NewImage carries
// referredBy and its OldImage did not (covers both the INSERT case — a create
// that somehow lands with referredBy already set — and the ordinary MODIFY
// case, since POST /api/users' referral attach is always a second write after
// the profile upsert that created the item). attribute_not_exists makes this
// replay-safe against a redelivered record.
async function handleUserReferralMarker(record: DynamoDBRecord): Promise<void> {
  if (!record.dynamodb?.NewImage) return;
  const newImage = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>);
  const referrerId = newImage.referredBy as string | undefined;
  if (!referrerId) return;

  if (record.dynamodb.OldImage) {
    const oldImage = unmarshall(record.dynamodb.OldImage as Record<string, AttributeValue>);
    if (oldImage.referredBy) return;
  }

  const referredUserId = newImage.userId as string;
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `POINTS#${referredUserId}`,
          SK: "REFERREDBY",
          referrerId,
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }
}

async function upsertFeedItem(meme: Record<string, unknown>): Promise<void> {
  const score = (meme.score as number) ?? 0;
  await docClient.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: "FEED#GLOBAL",
        SK: `${padScore(score)}#${meme.memeId}`,
        // GSI3: chronological ordering for "newest" reads
        GSI3PK: "FEED#GLOBAL",
        GSI3SK: meme.createdAt ?? new Date().toISOString(),
        memeId: meme.memeId,
        creatorId: meme.creatorId,
        s3Key: meme.s3Key,
        caption: meme.caption ?? "",
        score,
      },
    })
  );
}

async function deleteFeedItem(memeId: string, score: number): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: "FEED#GLOBAL", SK: `${padScore(score)}#${memeId}` },
    })
  );
}

// Returns the count BEFORE this delta was applied (0 if the item didn't exist
// yet) — KAN-101 uses that to tell a creator's first-ever clean meme apart
// from a later one, without a separate read.
async function adjustLeaderboard(creatorId: string, delta: 1 | -1): Promise<number> {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` },
      UpdateExpression:
        "ADD memeCount :delta SET creatorId = if_not_exists(creatorId, :cid)",
      ExpressionAttributeValues: { ":delta": delta, ":cid": creatorId },
      ReturnValues: "UPDATED_OLD",
    })
  );
  return (result.Attributes?.memeCount as number) ?? 0;
}

// REPORTQUEUE#GLOBAL: the admin listing's materialized view (KAN-43 follow-up),
// same shape as FEED#GLOBAL/LEADERBOARD#GLOBAL above. SK is memeId, not
// time-ordered, so the item is directly addressable for both this upsert and
// the takedown delete below without a prior read.
//
// Pure idempotent UpdateItem, no ConditionExpression: if_not_exists on
// memeId/creatorId/s3Key/reason/firstReportedAt makes "first write wins"
// replay-safe (a redelivered record just re-sets the same values), and ADD on
// a String Set is idempotent for an already-present element, so a replayed
// report insert cannot double-count a reporter. lastReportedAt is a plain SET
// rather than if_not_exists, which is still replay-safe because a replay
// carries the identical createdAt each time.
async function upsertReportQueueItem(
  memeId: string,
  reason: string,
  createdAt: string,
  identityHash: string
): Promise<void> {
  const memeResult = await docClient.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } })
  );
  const meme = memeResult.Item;
  // The report route always checks the meme exists before writing the
  // REPORT# item, so this should never happen outside a race; nothing to
  // queue if it does.
  if (!meme) return;

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeId}` },
      UpdateExpression:
        "SET memeId = if_not_exists(memeId, :memeId), " +
        "creatorId = if_not_exists(creatorId, :creatorId), " +
        "s3Key = if_not_exists(s3Key, :s3Key), " +
        "reason = if_not_exists(reason, :reason), " +
        "firstReportedAt = if_not_exists(firstReportedAt, :createdAt), " +
        "lastReportedAt = :createdAt " +
        "ADD reporterHashes :hashSet",
      ExpressionAttributeValues: {
        ":memeId": memeId,
        ":creatorId": meme.creatorId,
        ":s3Key": meme.s3Key,
        ":reason": reason,
        ":createdAt": createdAt,
        ":hashSet": new Set([identityHash]),
      },
    })
  );
}

async function deleteReportQueueItem(memeId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeId}` },
    })
  );
}

// Reason + distinct-reporter count for the takedown SNS body. Self-contained
// query (no lib/db.ts import, same as lambdas/moderation-handler) — REPORT#
// items live under the meme's own item collection, no new access pattern.
async function getReportSummary(
  memeId: string
): Promise<{ reason: string; reporterCount: number }> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `MEME#${memeId}`, ":prefix": "REPORT#" },
    })
  );
  const items = result.Items ?? [];
  if (items.length === 0) return { reason: "N/A", reporterCount: 0 };
  const sorted = [...items].sort((a, b) =>
    (a.createdAt as string).localeCompare(b.createdAt as string)
  );
  return { reason: sorted[0].reason as string, reporterCount: items.length };
}

// KAN-43 takedown side effects, triggered by the admin API route flipping
// status to "removed". Feed/leaderboard removal is handled by the existing
// wasClean/!isClean branch below (isCleanStatus now excludes "removed" too);
// this covers the parts that branch doesn't: deleting the asset, invalidating
// it at the edge, and notifying. Runs regardless of the prior status (a meme
// already in pending_review can still be taken down), so it's a standalone
// check rather than nested inside that branch.
async function takedownMeme(meme: Record<string, unknown>): Promise<void> {
  const memeId = meme.memeId as string;
  const s3Key = meme.s3Key as string;

  await s3.send(
    new DeleteObjectCommand({ Bucket: getEnv("S3_BUCKET_NAME"), Key: s3Key })
  );
  await cloudfront.send(
    new CreateInvalidationCommand({
      DistributionId: getEnv("CLOUDFRONT_DISTRIBUTION_ID"),
      InvalidationBatch: {
        CallerReference: `takedown-${memeId}-${Date.now()}`,
        Paths: { Quantity: 1, Items: [`/${s3Key}`] },
      },
    })
  );

  // A removed meme leaves the operator queue too.
  await deleteReportQueueItem(memeId);

  const { reason, reporterCount } = await getReportSummary(memeId);

  // Never rethrown: a broken alerts topic must not fail the takedown itself,
  // which has already succeeded by this point (see lib/rate-limit.ts for the
  // same fail-open-on-notify philosophy).
  try {
    await sns.send(
      new PublishCommand({
        TopicArn: getEnv("SNS_ALERTS_TOPIC_ARN"),
        Subject: `MemeDay takedown: ${memeId}`,
        Message: [
          `memeId: ${memeId}`,
          `creatorId: ${meme.creatorId as string}`,
          `reason: ${reason}`,
          `distinct reporters: ${reporterCount}`,
          `operator: ${(meme.removedBy as string) ?? "unknown"}`,
          `timestamp: ${new Date().toISOString()}`,
        ].join("\n"),
      })
    );
  } catch (err) {
    console.error(`failed to publish takedown alert for ${memeId}:`, err);
  }
}

export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    const pk = record.dynamodb?.Keys?.PK?.S ?? "";
    const sk = record.dynamodb?.Keys?.SK?.S ?? "";

    // Report items (PK=MEME#<id>, SK=REPORT#<hash>) maintain the
    // REPORTQUEUE#GLOBAL materialized view (KAN-43 follow-up). Only INSERT
    // matters: reports are never updated or deleted by the app.
    if (pk.startsWith("MEME#") && sk.startsWith("REPORT#")) {
      if (record.eventName === "INSERT" && record.dynamodb?.NewImage) {
        try {
          const report = unmarshall(
            record.dynamodb.NewImage as Record<string, AttributeValue>
          );
          const memeId = pk.slice("MEME#".length);
          const identityHash = sk.slice("REPORT#".length);
          await upsertReportQueueItem(
            memeId,
            report.reason as string,
            report.createdAt as string,
            identityHash
          );
        } catch (err) {
          console.error(`Error on ${pk}/${sk} [${record.eventName}]:`, err);
        }
      }
      continue;
    }

    // LIKE# items (PK=MEME#<id>, SK=LIKE#<userId>) — KAN-101 give/receive
    // like points. Likes are create-only (see lib/db.ts voteMeme), so only
    // INSERT matters here.
    if (pk.startsWith("MEME#") && sk.startsWith("LIKE#")) {
      if (record.eventName === "INSERT" && record.dynamodb?.NewImage) {
        try {
          const like = unmarshall(
            record.dynamodb.NewImage as Record<string, AttributeValue>
          );
          const memeId = pk.slice("MEME#".length);
          const likerUserId = sk.slice("LIKE#".length);
          await handleLikeAward(memeId, likerUserId, like.createdAt as string);
        } catch (err) {
          console.error(`Error on ${pk}/${sk} [${record.eventName}]:`, err);
        }
      }
      continue;
    }

    // COMMENT# items (PK=MEME#<id>, SK=COMMENT#<createdAt>#<commentId>) —
    // KAN-101 give/receive comment points. Comments are create-only (see
    // lib/db.ts addComment), so only INSERT matters here.
    if (pk.startsWith("MEME#") && sk.startsWith("COMMENT#")) {
      if (record.eventName === "INSERT" && record.dynamodb?.NewImage) {
        try {
          const comment = unmarshall(
            record.dynamodb.NewImage as Record<string, AttributeValue>
          );
          await handleCommentAward(comment);
        } catch (err) {
          console.error(`Error on ${pk}/${sk} [${record.eventName}]:`, err);
        }
      }
      continue;
    }

    // USER# items (PK=USER#<id>, SK=USER#<id>) — KAN-101 referral marker.
    if (pk.startsWith("USER#") && sk.startsWith("USER#")) {
      try {
        await handleUserReferralMarker(record);
      } catch (err) {
        console.error(`Error on ${pk}/${sk} [${record.eventName}]:`, err);
      }
      continue;
    }

    // Only act on base meme items (PK=MEME#<id>, SK=MEME#<id>)
    if (!pk.startsWith("MEME#") || !sk.startsWith("MEME#")) continue;

    try {
      if (record.eventName === "INSERT" && record.dynamodb?.NewImage) {
        const meme = unmarshall(
          record.dynamodb.NewImage as Record<string, AttributeValue>
        );
        if (isCleanStatus(meme.status)) {
          await upsertFeedItem(meme);
          const prevMemeCount = await adjustLeaderboard(meme.creatorId as string, 1);

          const memeId = meme.memeId as string;
          const creatorId = meme.creatorId as string;
          const createdAt = meme.createdAt as string;
          await safePointsOp(
            () =>
              awardPoints({
                earnerId: creatorId,
                action: "UPLOAD",
                awardSk: `AWARD#UPLOAD#${memeId}`,
                sourceId: memeId,
                createdAt,
              }),
            `upload by ${creatorId} for ${memeId}`
          );
          if (prevMemeCount === 0) {
            await maybeAwardReferral(creatorId, memeId, createdAt);
          }
        }
      } else if (
        record.eventName === "MODIFY" &&
        record.dynamodb?.NewImage &&
        record.dynamodb?.OldImage
      ) {
        const newMeme = unmarshall(
          record.dynamodb.NewImage as Record<string, AttributeValue>
        );
        const oldMeme = unmarshall(
          record.dynamodb.OldImage as Record<string, AttributeValue>
        );
        const oldScore = (oldMeme.score as number) ?? 0;
        const newScore = (newMeme.score as number) ?? 0;
        const wasClean = isCleanStatus(oldMeme.status);
        const isClean = isCleanStatus(newMeme.status);

        if (wasClean && !isClean) {
          // Flagged after publish (the finalize-before-screen race) — pull it
          // back out of the feed and undo its leaderboard count.
          await deleteFeedItem(newMeme.memeId as string, oldScore);
          await adjustLeaderboard(newMeme.creatorId as string, -1);

          const memeId = newMeme.memeId as string;
          const creatorId = newMeme.creatorId as string;
          const createdAt = newMeme.createdAt as string;
          await safePointsOp(
            () => reverseUploadAward(creatorId, memeId, createdAt),
            `reverse upload award for ${creatorId} on ${memeId}`
          );
          await safePointsOp(
            () => reverseReferralAwardIfQualifying(creatorId, memeId, createdAt),
            `reverse referral award qualified by ${memeId}`
          );
        } else if (!wasClean && isClean) {
          await upsertFeedItem(newMeme);
          await adjustLeaderboard(newMeme.creatorId as string, 1);
        } else if (wasClean && isClean && newScore !== oldScore) {
          await deleteFeedItem(newMeme.memeId as string, oldScore);
          await upsertFeedItem(newMeme);
        }

        if (newMeme.status === "removed" && oldMeme.status !== "removed") {
          await takedownMeme(newMeme);
        }
      } else if (record.eventName === "REMOVE" && record.dynamodb?.OldImage) {
        const meme = unmarshall(
          record.dynamodb.OldImage as Record<string, AttributeValue>
        );
        if (isCleanStatus(meme.status)) {
          await deleteFeedItem(meme.memeId as string, (meme.score as number) ?? 0);
          await adjustLeaderboard(meme.creatorId as string, -1);
        }
      }
    } catch (err) {
      console.error(`Error on ${pk}/${sk} [${record.eventName}]:`, err);
    }
  }
};
