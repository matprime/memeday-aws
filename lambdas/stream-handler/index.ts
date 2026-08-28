import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  QueryCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type { DynamoDBStreamHandler } from "aws-lambda";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// Exported so tests can stub .send instead of hitting live S3/CloudFront/SNS,
// same pattern as lambdas/moderation-handler's exported rekognition client.
export const s3 = new S3Client({});
export const cloudfront = new CloudFrontClient({});
export const sns = new SNSClient({});

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
