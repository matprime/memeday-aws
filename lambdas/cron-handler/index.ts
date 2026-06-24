import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const eb = new EventBridgeClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME!;
const DECAY_FACTOR = 0.9;

interface WinnerDetail {
  memeId: string;
  creatorId: string;
  s3Key: string;
  caption: string;
  date: string;
}

export async function handler(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const cutoff = new Date(Date.now() - 86_400_000).toISOString(); // 24 h ago

  const winner = await archiveDailyWinner(today);
  if (winner) {
    await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: "memeday.platform",
            DetailType: "daily-winner-archived",
            Detail: JSON.stringify(winner),
          },
        ],
      })
    );
  }

  await decayScores(cutoff);
}

// Returns the winner detail if newly archived, null if already done today.
async function archiveDailyWinner(date: string): Promise<WinnerDetail | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "FEED#GLOBAL" },
      ScanIndexForward: false,
      Limit: 1,
    })
  );

  const top = result.Items?.[0];
  if (!top?.memeId) return null;

  const detail: WinnerDetail = {
    memeId: top.memeId as string,
    creatorId: top.creatorId as string,
    s3Key: top.s3Key as string,
    caption: top.caption as string,
    date,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: "FEATURED#DAILY",
          SK: date,
          ...detail,
          score: top.score,
          archivedAt: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(SK)",
      })
    );
    return detail; // newly archived — emit event
  } catch (err) {
    if ((err as { name?: string })?.name !== "ConditionalCheckFailedException") throw err;
    return null; // already archived today — don't re-emit
  }
}

async function decayScores(cutoff: string): Promise<void> {
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": "FEED#GLOBAL" },
        ExclusiveStartKey: lastKey,
      })
    );

    for (const item of result.Items ?? []) {
      const createdAt = item.GSI3SK as string;
      const score = Number(item.score ?? 0);

      if (score <= 0 || !createdAt || createdAt >= cutoff) continue;

      const newScore = Math.floor(score * DECAY_FACTOR);
      if (newScore === score) continue;

      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { PK: `MEME#${item.memeId}`, SK: `MEME#${item.memeId}` },
            UpdateExpression: "SET score = :new",
            ConditionExpression: "score = :current",
            ExpressionAttributeValues: { ":new": newScore, ":current": score },
          })
        );
        // Stream handler picks up MODIFY and re-sorts FEED#GLOBAL
      } catch (err) {
        if ((err as { name?: string })?.name !== "ConditionalCheckFailedException") throw err;
        // Score changed concurrently (like landed) — skip, decay next run
      }
    }

    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
}
