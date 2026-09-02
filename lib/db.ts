import { unstable_noStore as noStore } from "next/cache";
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { dynamo, TABLE } from "./dynamo";
import type { DbBagsToken, DbComment, DbMeme, DbPendingUpload, DbUser, OpenReport } from "./types";

const PENDING_UPLOAD_TTL_SECONDS = 24 * 60 * 60;

const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN ?? "";

function cfUrl(s3Key: string): string {
  return CLOUDFRONT_DOMAIN
    ? `https://${CLOUDFRONT_DOMAIN}/${s3Key}`
    : `/api/image/${s3Key}`;
}

function parseMeme(item: Record<string, unknown>): DbMeme {
  return {
    id: item.memeId as string,
    creatorId: item.creatorId as string,
    ownerId: item.ownerId as string,
    creatorWalletAddr: item.creatorWalletAddr as string | undefined,
    s3Key: item.s3Key as string,
    imageUrl: cfUrl(item.s3Key as string),
    caption: item.caption as string,
    nftMint: item.nftMint as string | undefined,
    status: (item.status as DbMeme["status"]) ?? "active",
    likeCount: (item.likeCount as number) ?? 0,
    commentCount: (item.commentCount as number) ?? 0,
    score: (item.score as number) ?? 0,
    listingPrice: item.listingPrice as number | undefined,
    createdAt: item.createdAt as string,
  };
}

function parsePendingUpload(item: Record<string, unknown>): DbPendingUpload {
  return {
    id: item.pendingId as string,
    creatorId: item.creatorId as string,
    s3Key: item.s3Key as string,
    caption: item.caption as string,
    status: item.status as DbPendingUpload["status"],
    reason: item.reason as string | undefined,
    createdAt: item.createdAt as string,
  };
}

function parseComment(item: Record<string, unknown>): DbComment {
  return {
    id: item.commentId as string,
    memeId: item.memeId as string,
    userId: item.userId as string,
    walletAddr: item.walletAddr as string | undefined,
    body: item.body as string,
    createdAt: item.createdAt as string,
  };
}

function parseBagsToken(item: Record<string, unknown>): DbBagsToken {
  return {
    creatorId: item.creatorId as string,
    tokenMint: item.tokenMint as string,
    symbol: item.symbol as string,
    name: item.name as string,
    partnerAttributed: (item.partnerAttributed as boolean) ?? false,
    verifiedAt: item.verifiedAt as string,
  };
}

function parseUser(item: Record<string, unknown>): DbUser {
  return {
    userId: item.userId as string,
    email: item.email as string | undefined,
    walletAddr: item.walletAddr as string | undefined,
    walletVerifiedAt: item.walletVerifiedAt as string | undefined,
    displayName: item.displayName as string | undefined,
    authMethods: (item.authMethods as string[]) ?? [],
    bagsProjectId: item.bagsProjectId as string | undefined,
    creatorTokenAddr: item.creatorTokenAddr as string | undefined,
    creatorTokenSymbol: item.creatorTokenSymbol as string | undefined,
    credScore: (item.credScore as number) ?? 0,
    createdAt: item.createdAt as string,
  };
}

// Batch-fetch multiple USER# rows in one round trip, keyed by userId (KAN-75
// follow-up). Lets the meme-serving functions below check every creator's
// current walletVerifiedAt without a read per meme: one extra BatchGet for
// the distinct creators in a page, alongside the BatchGet they already do for
// the meme rows themselves.
async function getUsersByIds(userIds: string[]): Promise<Map<string, DbUser>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const result = await dynamo.send(
    new BatchGetCommand({
      RequestItems: {
        [TABLE]: { Keys: unique.map((id) => ({ PK: `USER#${id}`, SK: `USER#${id}` })) },
      },
    })
  );
  const map = new Map<string, DbUser>();
  for (const item of result.Responses?.[TABLE] ?? []) {
    const user = parseUser(item as Record<string, unknown>);
    map.set(user.userId, user);
  }
  return map;
}

// A creatorWalletAddr snapshot is safe to hand to a tip button only if the
// creator's USER# row currently has walletVerifiedAt set (KAN-75 follow-up).
// The snapshot on the meme itself never expires and is never touched when a
// creator later re-links, so this has to be re-checked against live user
// data on every serve, not cached on the meme or decided in a component.
function withVerifiedTipDestination(meme: DbMeme, creators: Map<string, DbUser>): DbMeme {
  if (!meme.creatorWalletAddr) return meme;
  const creator = creators.get(meme.creatorId);
  if (creator?.walletVerifiedAt) return meme;
  return { ...meme, creatorWalletAddr: undefined };
}

// Query FEED#GLOBAL via GSI3 (createdAt desc = newest first), BatchGet full items.
export async function getMemes(): Promise<DbMeme[]> {
  noStore();
  const feedResult = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "GSI3",
      KeyConditionExpression: "GSI3PK = :pk",
      ExpressionAttributeValues: { ":pk": "FEED#GLOBAL" },
      ScanIndexForward: false,
    })
  );
  const items = feedResult.Items ?? [];
  if (items.length === 0) return [];

  const keys = items.map((item) => ({
    PK: `MEME#${item.memeId as string}`,
    SK: `MEME#${item.memeId as string}`,
  }));
  const batchResult = await dynamo.send(
    new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keys } } })
  );
  const memes = (batchResult.Responses?.[TABLE] ?? [])
    .map((item) => parseMeme(item as Record<string, unknown>))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const creators = await getUsersByIds(
    memes.filter((m) => m.creatorWalletAddr).map((m) => m.creatorId)
  );
  return memes.map((m) => withVerifiedTipDestination(m, creators));
}

// Query FEED#GLOBAL base table (score desc = highest score first), GetItem for full details.
export async function getMemeOfDay(): Promise<DbMeme | null> {
  noStore();
  const feedResult = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "FEED#GLOBAL" },
      ScanIndexForward: false,
      Limit: 1,
    })
  );
  const top = feedResult.Items?.[0];
  if (!top) return null;
  return getMemeById(top.memeId as string);
}

// Query LEADERBOARD#GLOBAL for meme counts per creator.
export async function getLeaderboardCounts(): Promise<
  { creatorId: string; memeCount: number }[]
> {
  noStore();
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "LEADERBOARD#GLOBAL" },
    })
  );
  return (result.Items ?? [])
    .map((item) => ({
      creatorId: item.creatorId as string,
      memeCount: (item.memeCount as number) ?? 0,
    }))
    .sort((a, b) => b.memeCount - a.memeCount);
}

// Flagged for review = never reachable by direct URL (KAN-44).
// Removed (admin takedown, KAN-43) reuses the same not-found handling.
export async function getMemeById(id: string): Promise<DbMeme | null> {
  noStore();
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `MEME#${id}`, SK: `MEME#${id}` },
    })
  );
  if (!result.Item) return null;
  const meme = parseMeme(result.Item as Record<string, unknown>);
  if (meme.status === "pending_review" || meme.status === "removed") return null;
  if (!meme.creatorWalletAddr) return meme;
  // Single meme, so a plain getUserById is enough here (no batching needed).
  const creator = await getUserById(meme.creatorId);
  return withVerifiedTipDestination(meme, creator ? new Map([[creator.userId, creator]]) : new Map());
}

// Query GSI1 to get memes created by a specific user (creatorId = Cognito sub).
// Excludes pending_review: flagged uploads never appear on a creator profile (KAN-44).
export async function getMemesByCreator(userId: string): Promise<DbMeme[]> {
  noStore();
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :creator AND begins_with(GSI1SK, :mp)",
      ExpressionAttributeValues: {
        ":creator": `USER#${userId}`,
        ":mp": "MEME#",
      },
    })
  );
  const memes = (result.Items ?? [])
    .map((item) => parseMeme(item as Record<string, unknown>))
    .filter((meme) => meme.status !== "pending_review");

  // Every meme here shares the same creator (the profile owner), so this is
  // one extra read regardless of how many memes are shown, not one per card.
  if (!memes.some((m) => m.creatorWalletAddr)) return memes;
  const creator = await getUserById(userId);
  const creators = creator ? new Map([[creator.userId, creator]]) : new Map();
  return memes.map((m) => withVerifiedTipDestination(m, creators));
}

// Created before the S3 presigned URL is issued so the S3-triggered validation
// Lambda has a record to update (see lambdas/s3-handler). expiresAt is a
// DynamoDB TTL attribute (dev-stack only) that sweeps stale/rejected entries.
export async function createPendingUpload(pending: {
  id: string;
  creatorId: string;
  s3Key: string;
  caption: string;
}): Promise<DbPendingUpload> {
  const now = new Date().toISOString();
  const item: Record<string, unknown> = {
    PK: `PENDING#${pending.id}`,
    SK: `PENDING#${pending.id}`,
    pendingId: pending.id,
    creatorId: pending.creatorId,
    s3Key: pending.s3Key,
    caption: pending.caption,
    status: "pending_upload",
    createdAt: now,
    expiresAt: Math.floor(Date.now() / 1000) + PENDING_UPLOAD_TTL_SECONDS,
  };
  await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
  return parsePendingUpload(item);
}

export async function getPendingUpload(id: string): Promise<DbPendingUpload | null> {
  noStore();
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `PENDING#${id}`, SK: `PENDING#${id}` },
    })
  );
  if (!result.Item) return null;
  return parsePendingUpload(result.Item as Record<string, unknown>);
}

async function deletePendingUpload(id: string): Promise<void> {
  await dynamo.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: `PENDING#${id}`, SK: `PENDING#${id}` },
    })
  );
}

// Turns a validated (status: "active") pending upload into a real, feed-visible
// Meme item, then removes the pending record. Callers must check
// pending.status === "active" first (see app/api/memes POST).
export async function finalizeMeme(
  pending: DbPendingUpload,
  extra: { nftMint?: string; listingPrice?: number; isNFT: boolean }
): Promise<DbMeme> {
  // Read the creator here, not at presign time. The client upserts its user
  // profile between requesting the upload URL and posting the meme, so an
  // earlier read misses first-time creators and leaves the meme with no
  // creator wallet, which makes it permanently untippable.
  const creator = await getUserById(pending.creatorId);
  // Only snapshot the wallet when it is proven (KAN-75). An unverified
  // walletAddr must never become a tip destination, and creatorWalletAddr is
  // the only field MemeActionBar/MemeCard read for that — leaving it unset
  // reuses the existing "no wallet" UI path instead of adding a new check
  // there.
  const meme = await createMeme({
    creatorId: pending.creatorId,
    creatorWalletAddr: creator?.walletVerifiedAt ? creator.walletAddr : undefined,
    s3Key: pending.s3Key,
    caption: pending.caption,
    nftMint: extra.nftMint,
    listingPrice: extra.listingPrice,
    isNFT: extra.isNFT,
    id: pending.id,
  });
  await deletePendingUpload(pending.id);
  return meme;
}

export async function createMeme(meme: {
  creatorId: string;
  creatorWalletAddr?: string;
  s3Key: string;
  caption: string;
  nftMint?: string;
  listingPrice?: number;
  isNFT: boolean;
  id?: string;
}): Promise<DbMeme> {
  const id = meme.id ?? randomUUID();
  const now = new Date().toISOString();
  const status: DbMeme["status"] = meme.listingPrice ? "listed" : "active";

  const item: Record<string, unknown> = {
    PK: `MEME#${id}`,
    SK: `MEME#${id}`,
    GSI1PK: `USER#${meme.creatorId}`,
    GSI1SK: `MEME#${now}`,
    GSI2PK: `OWNER#${meme.creatorId}`,
    GSI2SK: `MEME#${now}`,
    memeId: id,
    creatorId: meme.creatorId,
    ownerId: meme.creatorId,
    s3Key: meme.s3Key,
    caption: meme.caption,
    status,
    likeCount: 0,
    commentCount: 0,
    score: 0,
    createdAt: now,
  };
  if (meme.creatorWalletAddr) item.creatorWalletAddr = meme.creatorWalletAddr;
  if (meme.nftMint) item.nftMint = meme.nftMint;
  if (meme.listingPrice !== undefined) item.listingPrice = meme.listingPrice;

  await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
  return parseMeme(item);
}

export async function getComments(memeId: string): Promise<DbComment[]> {
  noStore();
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `MEME#${memeId}`,
        ":prefix": "COMMENT#",
      },
    })
  );
  return (result.Items ?? []).map((item) =>
    parseComment(item as Record<string, unknown>)
  );
}

export async function addComment(comment: {
  memeId: string;
  userId: string;
  walletAddr?: string;
  body: string;
}): Promise<DbComment> {
  const id = randomUUID();
  const now = new Date().toISOString();

  const item: Record<string, unknown> = {
    PK: `MEME#${comment.memeId}`,
    SK: `COMMENT#${now}#${id}`,
    commentId: id,
    memeId: comment.memeId,
    userId: comment.userId,
    body: comment.body,
    createdAt: now,
  };
  if (comment.walletAddr) item.walletAddr = comment.walletAddr;

  await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `MEME#${comment.memeId}`, SK: `MEME#${comment.memeId}` },
      UpdateExpression: "ADD commentCount :one",
      ExpressionAttributeValues: { ":one": 1 },
    })
  );

  return parseComment(item);
}

// Returns true if vote was recorded, false if the user already voted.
// Uses a conditional PutItem on LIKE#<userId> for server-side dedup.
export async function voteMeme(memeId: string, userId: string): Promise<boolean> {
  try {
    await dynamo.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `MEME#${memeId}`,
          SK: `LIKE#${userId}`,
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
      UpdateExpression: "ADD likeCount :one, score :one",
      ExpressionAttributeValues: { ":one": 1 },
    })
  );
  return true;
}

export async function upsertUser(user: {
  userId: string;
  email?: string;
  walletAddr?: string;
  // True only when the caller already proved ownership of walletAddr, via a
  // real signature check or a Cognito wallet_<addr> token (KAN-75). Callers
  // must never derive this from a client-supplied flag.
  walletVerified?: boolean;
  displayName?: string;
  authMethods?: string[];
  bagsProjectId?: string;
  creatorTokenAddr?: string;
  creatorTokenSymbol?: string;
}): Promise<DbUser> {
  const now = new Date().toISOString();

  let updateExpr =
    "SET #uid = :uid, createdAt = if_not_exists(createdAt, :now), credScore = if_not_exists(credScore, :zero), authMethods = :am";
  const exprNames: Record<string, string> = { "#uid": "userId" };
  const exprVals: Record<string, unknown> = {
    ":uid": user.userId,
    ":now": now,
    ":zero": 0,
    ":am": user.authMethods ?? [],
  };

  if (user.email !== undefined) {
    updateExpr += ", email = :email, GSI1PK = :emailKey, GSI1SK = :userKey";
    exprVals[":email"] = user.email;
    exprVals[":emailKey"] = `EMAIL#${user.email}`;
    exprVals[":userKey"] = `USER#${user.userId}`;
  }
  if (user.walletAddr !== undefined) {
    updateExpr += ", walletAddr = :walletAddr, GSI2PK = :walletKey, GSI2SK = :userKey2";
    exprVals[":walletAddr"] = user.walletAddr;
    exprVals[":walletKey"] = `WALLET#${user.walletAddr}`;
    exprVals[":userKey2"] = `USER#${user.userId}`;
    // Only ever stamped, never cleared here: a caller that omits walletAddr
    // entirely takes the branch above this one and never reaches this block,
    // so an existing verified stamp is untouched by unrelated profile writes.
    if (user.walletVerified) {
      updateExpr += ", walletVerifiedAt = :walletVerifiedAt";
      exprVals[":walletVerifiedAt"] = now;
    }
  }
  if (user.displayName !== undefined) {
    updateExpr += ", displayName = :displayName";
    exprVals[":displayName"] = user.displayName;
  }
  if (user.bagsProjectId !== undefined) {
    updateExpr += ", bagsProjectId = :bagsProjectId";
    exprVals[":bagsProjectId"] = user.bagsProjectId;
  }
  if (user.creatorTokenAddr !== undefined) {
    updateExpr += ", creatorTokenAddr = :creatorTokenAddr";
    exprVals[":creatorTokenAddr"] = user.creatorTokenAddr;
  }
  if (user.creatorTokenSymbol !== undefined) {
    updateExpr += ", creatorTokenSymbol = :creatorTokenSymbol";
    exprVals[":creatorTokenSymbol"] = user.creatorTokenSymbol;
  }

  const result = await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `USER#${user.userId}`, SK: `USER#${user.userId}` },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprVals,
      ReturnValues: "ALL_NEW",
    })
  );

  return parseUser(result.Attributes as Record<string, unknown>);
}

export async function getUserById(userId: string): Promise<DbUser | null> {
  noStore();
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `USER#${userId}`, SK: `USER#${userId}` },
    })
  );
  if (!result.Item) return null;
  return parseUser(result.Item as Record<string, unknown>);
}

export async function getAllUsers(): Promise<DbUser[]> {
  noStore();
  const result = await dynamo.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(PK, :up) AND begins_with(SK, :up)",
      ExpressionAttributeValues: { ":up": "USER#" },
    })
  );
  return (result.Items ?? []).map((item) =>
    parseUser(item as Record<string, unknown>)
  );
}

// Query GSI2 to look up a user by linked wallet address.
export async function getUserByWallet(wallet: string): Promise<DbUser | null> {
  noStore();
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :walletKey",
      ExpressionAttributeValues: { ":walletKey": `WALLET#${wallet}` },
      Limit: 1,
    })
  );
  const item = result.Items?.[0];
  if (!item) return null;
  return parseUser(item as Record<string, unknown>);
}

export interface NftMetadataRow {
  id: string;
  name: string;
  image_url: string;
  description: string;
}

export async function createNftMetadata(row: {
  name: string;
  image_url: string;
  description: string;
}): Promise<{ id: string }> {
  const id = randomUUID();
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `NFTMETA#${id}`,
        SK: `NFTMETA#${id}`,
        nftMetaId: id,
        name: row.name,
        image_url: row.image_url,
        description: row.description,
        createdAt: new Date().toISOString(),
      },
    })
  );
  return { id };
}

export async function getNftMetadata(id: string): Promise<NftMetadataRow | null> {
  noStore();
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `NFTMETA#${id}`, SK: `NFTMETA#${id}` },
    })
  );
  if (!result.Item) return null;
  const item = result.Item as Record<string, unknown>;
  return {
    id: item.nftMetaId as string,
    name: item.name as string,
    image_url: item.image_url as string,
    description: item.description as string,
  };
}

// Dedupe on (identity, meme) via a conditional PutItem on REPORT#<identityHash>,
// same pattern as voteMeme's LIKE#<userId> dedupe. First write wins: a repeat
// report from the same identity is rejected at the condition check and the
// original reason is never touched.
export async function createReport(report: {
  memeId: string;
  identityHash: string;
  reporterId?: string;
  reason: string;
}): Promise<{ isFirstReport: boolean }> {
  const item: Record<string, unknown> = {
    PK: `MEME#${report.memeId}`,
    SK: `REPORT#${report.identityHash}`,
    reason: report.reason,
    createdAt: new Date().toISOString(),
  };
  if (report.reporterId) item.reporterId = report.reporterId;

  try {
    await dynamo.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return { isFirstReport: false };
    }
    throw err;
  }

  // Consistent read: the SNS notify-on-first-report decision below depends on
  // this count being accurate immediately after the write above.
  const { Count } = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `MEME#${report.memeId}`, ":prefix": "REPORT#" },
      Select: "COUNT",
      ConsistentRead: true,
    })
  );
  return { isFirstReport: (Count ?? 0) === 1 };
}

// Which of the given memeIds does this identity already have a REPORT# item
// for — same existing per-meme access pattern as "did user like?" (see
// ARCHITECTURE.md), just checked across the currently-visible feed instead of
// one meme. Used to hide previously-reported memes from an authenticated
// reporter's own feed across sessions, without a new index.
export async function getReportedMemeIds(
  identityHash: string,
  memeIds: string[]
): Promise<string[]> {
  if (memeIds.length === 0) return [];
  const batchResult = await dynamo.send(
    new BatchGetCommand({
      RequestItems: {
        [TABLE]: {
          Keys: memeIds.map((id) => ({ PK: `MEME#${id}`, SK: `REPORT#${identityHash}` })),
        },
      },
    })
  );
  return (batchResult.Responses?.[TABLE] ?? []).map(
    (item) => (item.PK as string).slice("MEME#".length)
  );
}

// Distinct reporters + reason/timestamps for a meme's REPORT# items, used by
// both the admin listing (getOpenReports) and the takedown Lambda's SNS body.
export async function getReportSummary(
  memeId: string
): Promise<{ reason: string; reporterCount: number; firstReportedAt: string; lastReportedAt: string } | null> {
  noStore();
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `MEME#${memeId}`, ":prefix": "REPORT#" },
    })
  );
  const items = result.Items ?? [];
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) =>
    (a.createdAt as string).localeCompare(b.createdAt as string)
  );
  return {
    reason: sorted[0].reason as string,
    reporterCount: items.length,
    firstReportedAt: sorted[0].createdAt as string,
    lastReportedAt: sorted[sorted.length - 1].createdAt as string,
  };
}

// REPORTQUEUE#GLOBAL is a Streams-maintained materialized view (KAN-43
// follow-up), same pattern as FEED#GLOBAL/LEADERBOARD#GLOBAL: the Streams
// handler upserts one queue item per meme on a REPORT# insert and deletes it
// on takedown, so this is a single Query, no Scan and no new GSI. The SK
// (memeId) isn't time-ordered, so ordering happens here instead.
export async function getOpenReports(): Promise<OpenReport[]> {
  noStore();
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "REPORTQUEUE#GLOBAL" },
    })
  );
  const items = result.Items ?? [];
  return items
    .map((item) => ({
      memeId: item.memeId as string,
      s3Key: item.s3Key as string,
      imageUrl: cfUrl(item.s3Key as string),
      reason: item.reason as string,
      reporterCount: (item.reporterHashes as Set<string> | undefined)?.size ?? 0,
      firstReportedAt: item.firstReportedAt as string,
      lastReportedAt: item.lastReportedAt as string,
    }))
    .sort((a, b) => b.lastReportedAt.localeCompare(a.lastReportedAt));
}

// Vercel side of takedown (KAN-43): flips status only. S3 delete, CloudFront
// invalidation, and the takedown SNS notification are the Streams handler's
// job, triggered by this write. ConditionExpression guards against taking
// down a memeId that doesn't exist.
export async function takedownMeme(memeId: string, operatorId: string): Promise<boolean> {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` },
        UpdateExpression: "SET #status = :removed, removedBy = :operatorId",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":removed": "removed", ":operatorId": operatorId },
        ConditionExpression: "attribute_exists(PK)",
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

// Vercel side of dismiss (KAN-43 follow-up): deletes only the
// REPORTQUEUE#GLOBAL item (same key the Streams handler's
// deleteReportQueueItem targets on takedown, see lambdas/stream-handler).
// Touches nothing else — the meme item, its status, and the REPORT# audit
// trail under MEME#<memeId> are untouched, and this never publishes to SNS.
// No ConditionExpression: deleting an already-gone or never-existed queue
// item is a harmless no-op, there's no phantom item to guard against.
export async function dismissReport(memeId: string): Promise<void> {
  await dynamo.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeId}` },
    })
  );
}

// Overwrites on a repeat verify of the same mint (fresh verifiedAt/
// partnerAttributed) rather than rejecting — re-verifying isn't an error, and
// there is nothing here a second write would corrupt.
export async function createVerifiedBagsToken(token: {
  creatorId: string;
  tokenMint: string;
  symbol: string;
  name: string;
  partnerAttributed: boolean;
}): Promise<DbBagsToken> {
  const item: Record<string, unknown> = {
    PK: `USER#${token.creatorId}`,
    SK: `TOKEN#${token.tokenMint}`,
    creatorId: token.creatorId,
    tokenMint: token.tokenMint,
    symbol: token.symbol,
    name: token.name,
    partnerAttributed: token.partnerAttributed,
    verifiedAt: new Date().toISOString(),
  };
  await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
  return parseBagsToken(item);
}

// Shares the User row's PK by design (see DbBagsToken) — this Query only ever
// sees the TOKEN# items in that collection, never the USER# item itself.
export async function getVerifiedBagsTokensByCreator(creatorId: string): Promise<DbBagsToken[]> {
  noStore();
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `USER#${creatorId}`, ":prefix": "TOKEN#" },
    })
  );
  return (result.Items ?? []).map((item) => parseBagsToken(item as Record<string, unknown>));
}

// Single "does this creator have a token" read, shared by the profile page
// and the claim UI's launch-button-vs-card decision (KAN-29 follow-up), so
// both always agree on which one counts when a creator has claimed more than
// one launch: the most recently verified.
export async function getVerifiedBagsToken(creatorId: string): Promise<DbBagsToken | null> {
  const tokens = await getVerifiedBagsTokensByCreator(creatorId);
  if (tokens.length === 0) return null;
  return tokens.reduce((latest, t) => (t.verifiedAt > latest.verifiedAt ? t : latest));
}
