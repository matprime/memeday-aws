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
const TABLE = process.env.DYNAMODB_TABLE_NAME ?? "MemeDay";

// Zero-pad to 15 digits so DynamoDB lexicographic sort == numeric sort for scores.
function padScore(n: number): string {
  return Math.max(0, n).toString().padStart(15, "0");
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
        await upsertFeedItem(meme);
        await adjustLeaderboard(meme.creatorId as string, 1);
      } else if (
        record.eventName === "MODIFY" &&
        record.dynamodb?.NewImage &&
        record.dynamodb?.OldImage
      ) {
        const newMeme = unmarshall(
          record.dynamodb.NewImage as Record<string, AttributeValue>
        );
        const oldScore = (unmarshall(
          record.dynamodb.OldImage as Record<string, AttributeValue>
        ).score as number) ?? 0;
        const newScore = (newMeme.score as number) ?? 0;
        if (newScore !== oldScore) {
          await deleteFeedItem(newMeme.memeId as string, oldScore);
          await upsertFeedItem(newMeme);
        }
      } else if (record.eventName === "REMOVE" && record.dynamodb?.OldImage) {
        const meme = unmarshall(
          record.dynamodb.OldImage as Record<string, AttributeValue>
        );
        await deleteFeedItem(meme.memeId as string, (meme.score as number) ?? 0);
        await adjustLeaderboard(meme.creatorId as string, -1);
      }
    } catch (err) {
      console.error(`Error on ${pk}/${sk} [${record.eventName}]:`, err);
    }
  }
};
