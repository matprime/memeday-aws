import { unstable_noStore as noStore } from "next/cache";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { dynamo, TABLE } from "./dynamo";
import type { DbComment, DbMeme, DbUser } from "./types";

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

function parseUser(item: Record<string, unknown>): DbUser {
  return {
    userId: item.userId as string,
    email: item.email as string | undefined,
    walletAddr: item.walletAddr as string | undefined,
    displayName: item.displayName as string | undefined,
    authMethods: (item.authMethods as string[]) ?? [],
    bagsProjectId: item.bagsProjectId as string | undefined,
    creatorTokenAddr: item.creatorTokenAddr as string | undefined,
    credScore: (item.credScore as number) ?? 0,
    createdAt: item.createdAt as string,
  };
}

// Scans for all base meme items (PK=MEME#* SK=MEME#*).
// In production, the global feed would be served from the FEED#GLOBAL
// materialized view written by Lambda Streams. For the Vercel layer, scan suffices.
export async function getMemes(): Promise<DbMeme[]> {
  noStore();
  const result = await dynamo.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(PK, :mp) AND begins_with(SK, :mp)",
      ExpressionAttributeValues: { ":mp": "MEME#" },
    })
  );
  return (result.Items ?? [])
    .map((item) => parseMeme(item as Record<string, unknown>))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getMemeOfDay(): Promise<DbMeme | null> {
  noStore();
  const memes = await getMemes();
  if (memes.length === 0) return null;
  return memes.reduce((best, m) => (m.score > best.score ? m : best), memes[0]);
}

export async function getMemeById(id: string): Promise<DbMeme | null> {
  noStore();
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `MEME#${id}`, SK: `MEME#${id}` },
    })
  );
  if (!result.Item) return null;
  return parseMeme(result.Item as Record<string, unknown>);
}

// Query GSI1 to get memes created by a specific user (creatorId = Cognito sub).
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
  return (result.Items ?? []).map((item) =>
    parseMeme(item as Record<string, unknown>)
  );
}

export async function createMeme(meme: {
  creatorId: string;
  creatorWalletAddr?: string;
  s3Key: string;
  caption: string;
  nftMint?: string;
  listingPrice?: number;
  isNFT: boolean;
}): Promise<DbMeme> {
  const id = randomUUID();
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
  displayName?: string;
  authMethods?: string[];
  bagsProjectId?: string;
  creatorTokenAddr?: string;
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
