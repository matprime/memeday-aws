/**
 * One-time backfill: scan existing MEME# items and write
 * FEED#GLOBAL (score-sorted feed) and LEADERBOARD#GLOBAL (meme counts)
 * materialized views so the Lambda stream handler has a baseline to build on.
 *
 * Safe to re-run — overwrites feed entries and sets (not adds) leaderboard counts.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill.js
 *
 * Required env vars:
 *   AWS_REGION          e.g. eu-west-1
 *   DYNAMODB_TABLE      e.g. MemeDay
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  (or use an AWS profile)
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const TABLE = process.env.DYNAMODB_TABLE ?? "MemeDay";
const REGION = process.env.AWS_REGION ?? "eu-west-1";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

function padScore(score) {
  return String(Math.max(0, Math.floor(Number(score ?? 0)))).padStart(10, "0");
}

// BatchWrite retries unprocessed items up to 3 times with backoff.
async function batchWriteWithRetry(items, attempt = 0) {
  const result = await ddb.send(
    new BatchWriteCommand({ RequestItems: { [TABLE]: items } })
  );
  const unprocessed = result.UnprocessedItems?.[TABLE];
  if (unprocessed?.length) {
    if (attempt >= 3) throw new Error(`Unprocessed items after 3 retries`);
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    await batchWriteWithRetry(unprocessed, attempt + 1);
  }
}

async function main() {
  console.log(`Table: ${TABLE}  Region: ${REGION}`);
  console.log("Scanning memes...\n");

  let lastKey;
  let totalMemes = 0;
  const memeCountByCreator = {};

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression:
          "begins_with(PK, :mp) AND begins_with(SK, :mp)",
        ExpressionAttributeValues: { ":mp": "MEME#" },
        ExclusiveStartKey: lastKey,
      })
    );

    const memes = result.Items ?? [];
    totalMemes += memes.length;
    process.stdout.write(`\r  scanned ${totalMemes} memes...`);

    // Write feed entries in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < memes.length; i += 25) {
      const batch = memes.slice(i, i + 25).map((m) => ({
        PutRequest: {
          Item: {
            PK: "FEED#GLOBAL",
            SK: `${padScore(m.score)}#${m.memeId}`,
            GSI3PK: "FEED#GLOBAL",
            GSI3SK: m.createdAt,
            memeId: m.memeId,
            creatorId: m.creatorId,
            s3Key: m.s3Key,
            caption: m.caption,
            score: Number(m.score ?? 0),
          },
        },
      }));
      await batchWriteWithRetry(batch);
    }

    // Accumulate meme count per creator
    for (const m of memes) {
      if (m.creatorId) {
        memeCountByCreator[m.creatorId] =
          (memeCountByCreator[m.creatorId] ?? 0) + 1;
      }
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  const creatorCount = Object.keys(memeCountByCreator).length;
  console.log(
    `\n\nFeed entries written. Writing leaderboard for ${creatorCount} creators...`
  );

  // Write leaderboard entries — SET (not ADD) so re-runs are idempotent
  let done = 0;
  for (const [creatorId, count] of Object.entries(memeCountByCreator)) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: "LEADERBOARD#GLOBAL", SK: `USER#${creatorId}` },
        UpdateExpression: "SET memeCount = :count, creatorId = :cid",
        ExpressionAttributeValues: { ":count": count, ":cid": creatorId },
      })
    );
    done++;
    process.stdout.write(`\r  ${done}/${creatorCount} creators written...`);
  }

  console.log(`\n\nBackfill complete.`);
  console.log(`  ${totalMemes} memes → FEED#GLOBAL`);
  console.log(`  ${creatorCount} creators → LEADERBOARD#GLOBAL`);
}

main().catch((err) => {
  console.error("\nBackfill failed:", err.message ?? err);
  process.exit(1);
});
