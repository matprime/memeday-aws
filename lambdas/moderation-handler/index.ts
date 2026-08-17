import {
  RekognitionClient,
  DetectModerationLabelsCommand,
  type ModerationLabel,
} from "@aws-sdk/client-rekognition";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const rekognition = new RekognitionClient({});
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_TABLE_NAME!;

// Invoked directly by S3Handler after it validates and rewrites an upload
// (see lambdas/s3-handler) — no S3 event subscription of its own anymore.
interface ModerationInvokeEvent {
  bucket: string;
  key: string;
}

// MinConfidence at the API level: get everything back, then apply the block
// decision in code below. Not the same as the block threshold.
const API_MIN_CONFIDENCE = 50;

// Block threshold — a conservative starting default, not yet tuned against
// real output. Do not change without flagging (see ticket KAN-44).
const BLOCK_CONFIDENCE_THRESHOLD = 80;

// Exact label Names verified against current AWS docs for this ticket. Do not
// substitute, fuzzy-match, or add variants without re-verifying against AWS's
// Rekognition moderation taxonomy.
const BLOCK_LABELS = new Set<string>([
  // Explicit Nudity (top-level + named children)
  "Explicit Nudity",
  "Explicit Sexual Activity",
  "Sex Toys",
  "Exposed Male Genitalia",
  "Exposed Female Genitalia",
  "Exposed Buttocks or Anus",
  "Exposed Female Nipple",
  // Violence: Graphic Violence + its children, and Weapons
  "Graphic Violence",
  "Weapon Violence",
  "Physical Violence",
  "Self-Harm",
  "Blood & Gore",
  "Explosions and Blasts",
  "Weapons",
  // Hate Symbols (top-level + named children)
  "Hate Symbols",
  "Nazi Party",
  "White Supremacy",
  "Extremist",
]);

// Key format: uploads/<userId>/<pendingId>.<ext> (matches lambdas/s3-handler).
function pendingIdFromKey(key: string): string | null {
  const match = key.match(/^uploads\/[^/]+\/([^/.]+)\.[^/.]+$/);
  return match ? match[1] : null;
}

function isBlocked(labels: ModerationLabel[]): boolean {
  return labels.some(
    (label) =>
      label.Name !== undefined &&
      BLOCK_LABELS.has(label.Name) &&
      (label.Confidence ?? 0) >= BLOCK_CONFIDENCE_THRESHOLD
  );
}

function logModerationResult(params: {
  key: string;
  pendingId: string;
  labels: ModerationLabel[];
  action: "published" | "blocked" | "pending_review" | "blocked_orphan";
}): void {
  console.log(
    JSON.stringify({
      event: "moderation_result",
      key: params.key,
      pendingId: params.pendingId,
      action: params.action,
      labels: params.labels.map((l) => ({ name: l.Name, confidence: l.Confidence })),
    })
  );
}

// Applies a block decision to whichever record currently represents this
// upload. Screening runs async relative to the upload flow, so either a
// PENDING# record still exists (finalize hasn't happened yet — the common
// case, since finalize is gated on S3Handler's validation, not moderation),
// or the client already raced ahead and finalized into a MEME# item.
async function applyBlockDecision(
  pendingId: string
): Promise<"blocked" | "pending_review" | "blocked_orphan"> {
  const GENERIC_REASON = "Content does not meet our community guidelines.";

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `PENDING#${pendingId}`, SK: `PENDING#${pendingId}` },
        UpdateExpression: "SET #status = :rejected, reason = :reason",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":rejected": "rejected", ":reason": GENERIC_REASON },
      })
    );
    return "blocked";
  } catch (err) {
    if ((err as { name?: string })?.name !== "ConditionalCheckFailedException") throw err;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `MEME#${pendingId}`, SK: `MEME#${pendingId}` },
        UpdateExpression: "SET #status = :pendingReview",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":pendingReview": "pending_review" },
      })
    );
    return "pending_review";
  } catch (err) {
    if ((err as { name?: string })?.name !== "ConditionalCheckFailedException") throw err;
    return "blocked_orphan";
  }
}

export const handler = async (event: ModerationInvokeEvent): Promise<void> => {
  const { bucket, key } = event;

  const pendingId = pendingIdFromKey(key);
  if (!pendingId) {
    console.error(`Skipping key with unrecognized format: ${key}`);
    return;
  }

  try {
    let labels: ModerationLabel[];
    try {
      const result = await rekognition.send(
        new DetectModerationLabelsCommand({
          Image: { S3Object: { Bucket: bucket, Name: key } },
          MinConfidence: API_MIN_CONFIDENCE,
        })
      );
      labels = result.ModerationLabels ?? [];
    } catch (err) {
      // Fail open, matching S3Handler's existing convention of logging and
      // leaving state as-is on unexpected errors rather than inventing a
      // stricter failure posture. Known gap: Rekognition's
      // DetectModerationLabels only supports JPEG/PNG, so GIF/WEBP uploads
      // (both allowed by S3Handler) always land here and publish
      // unscreened — flagging as a follow-up, not solved by this ticket.
      console.error(`Rekognition call failed for key=${key} pendingId=${pendingId}:`, err);
      return;
    }

    if (isBlocked(labels)) {
      const outcome = await applyBlockDecision(pendingId);
      if (outcome === "blocked_orphan") {
        console.error(
          `Blocked content but found neither a PENDING# nor MEME# record: pendingId=${pendingId} key=${key}`
        );
      }
      logModerationResult({ key, pendingId, labels, action: outcome });
    } else {
      logModerationResult({ key, pendingId, labels, action: "published" });
    }
  } catch (err) {
    console.error(`Failed to process ${key}:`, err);
  }
};

export {
  pendingIdFromKey,
  isBlocked,
  applyBlockDecision,
  logModerationResult,
  BLOCK_LABELS,
  BLOCK_CONFIDENCE_THRESHOLD,
  rekognition,
};
