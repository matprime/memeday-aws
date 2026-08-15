import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBStreamHandler } from "aws-lambda";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// No fallback. The old "MemeDay" table survives the rename as an orphan, so a
// missing env var would silently write to a dead table rather than fail. CDK
// always injects this, so the throw only catches misconfiguration.
const tableName = process.env.DYNAMODB_TABLE_NAME;
if (!tableName) {
  throw new Error("Missing DYNAMODB_TABLE_NAME");
}
const TABLE = tableName;

// Zero-pad to 15 digits so DynamoDB lexicographic sort == numeric sort for scores.
function padScore(n: number): string {
  return Math.max(0, n).toString().padStart(15, "0");
}

// Flagged-for-review memes must never reach FEED#GLOBAL / GSI3 (KAN-44).
// Every other status (active, listed, sold, and the pre-KAN-44 default of
// undefined) is feed-eligible.
function isCleanStatus(status: unknown): boolean {
  return status !== "pending_review";
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

async function adjustLeaderboard(creatorId: string, delta: 1 | -1): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` },
      UpdateExpression:
        "ADD memeCount :delta SET creatorId = if_not_exists(creatorId, :cid)",
      ExpressionAttributeValues: { ":delta": delta, ":cid": creatorId },
    })
  );
}

export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    const pk = record.dynamodb?.Keys?.PK?.S ?? "";
    const sk = record.dynamodb?.Keys?.SK?.S ?? "";
    // Only act on base meme items (PK=MEME#<id>, SK=MEME#<id>)
    if (!pk.startsWith("MEME#") || !sk.startsWith("MEME#")) continue;

    try {
      if (record.eventName === "INSERT" && record.dynamodb?.NewImage) {
        const meme = unmarshall(
          record.dynamodb.NewImage as Record<string, AttributeValue>
        );
        if (isCleanStatus(meme.status)) {
          await upsertFeedItem(meme);
          await adjustLeaderboard(meme.creatorId as string, 1);
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
        } else if (!wasClean && isClean) {
          await upsertFeedItem(newMeme);
          await adjustLeaderboard(newMeme.creatorId as string, 1);
        } else if (wasClean && isClean && newScore !== oldScore) {
          await deleteFeedItem(newMeme.memeId as string, oldScore);
          await upsertFeedItem(newMeme);
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
