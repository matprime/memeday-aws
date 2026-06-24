import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME!;

type DdbImage = Record<string, AttributeValue>;

interface StreamRecord {
  eventName: "INSERT" | "MODIFY" | "REMOVE";
  dynamodb?: { NewImage?: DdbImage; OldImage?: DdbImage };
}

// Zero-pad score so lexicographic order matches numeric order (up to 10 digits)
function padScore(score: number): string {
  return String(Math.max(0, Math.floor(score))).padStart(10, "0");
}

export async function handler(event: { Records: StreamRecord[] }): Promise<void> {
  for (const record of event.Records) {
    await processRecord(record);
  }
}

async function processRecord(record: StreamRecord): Promise<void> {
  const { NewImage, OldImage } = record.dynamodb ?? {};
  const anyImage = NewImage ?? OldImage;
  if (!anyImage) return;

  const { PK, SK } = unmarshall(anyImage);

  // Only process base Meme items: PK=MEME#<id>, SK=MEME#<id>
  if (typeof PK !== "string" || typeof SK !== "string") return;
  if (!PK.startsWith("MEME#") || !SK.startsWith("MEME#")) return;

  const memeId = PK.slice(5);

  if (record.eventName === "REMOVE") {
    await handleRemove(memeId, OldImage!);
    return;
  }

  const newItem = unmarshall(NewImage!);

  if (record.eventName === "MODIFY" && OldImage) {
    const oldItem = unmarshall(OldImage);
    const oldScore = Number(oldItem.score ?? 0);
    const newScore = Number(newItem.score ?? 0);
    if (oldScore !== newScore) {
      await ddb.send(
        new DeleteCommand({
          TableName: TABLE,
          Key: { PK: "FEED#GLOBAL", SK: `${padScore(oldScore)}#${memeId}` },
        })
      );
    }
  }

  await writeFeedEntry(memeId, newItem);

  if (record.eventName === "INSERT") {
    await incrementLeaderboard(newItem.creatorId as string);
  }
}

async function handleRemove(memeId: string, oldImage: DdbImage): Promise<void> {
  const oldItem = unmarshall(oldImage);
  const score = Number(oldItem.score ?? 0);

  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: "FEED#GLOBAL", SK: `${padScore(score)}#${memeId}` },
    })
  );

  const creatorId = oldItem.creatorId as string;
  if (creatorId) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` },
        UpdateExpression: "ADD memeCount :neg",
        ExpressionAttributeValues: { ":neg": -1 },
      })
    );
  }
}

async function writeFeedEntry(
  memeId: string,
  item: Record<string, unknown>
): Promise<void> {
  const score = Number(item.score ?? 0);
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: "FEED#GLOBAL",
        SK: `${padScore(score)}#${memeId}`,
        GSI3PK: "FEED#GLOBAL",
        GSI3SK: item.createdAt,
        memeId,
        creatorId: item.creatorId,
        s3Key: item.s3Key,
        caption: item.caption,
        score,
      },
    })
  );
}

async function incrementLeaderboard(creatorId: string): Promise<void> {
  if (!creatorId) return;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` },
      UpdateExpression: "ADD memeCount :one SET creatorId = :cid",
      ExpressionAttributeValues: { ":one": 1, ":cid": creatorId },
    })
  );
}
