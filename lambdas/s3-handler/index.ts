import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import type { S3Handler } from "aws-lambda";
import sharp from "sharp";
import type { FormatEnum } from "sharp";

const s3 = new S3Client({});
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});
const BUCKET = process.env.S3_BUCKET_NAME!;
const TABLE = process.env.DYNAMODB_TABLE_NAME!;
const MODERATION_HANDLER_FUNCTION_NAME = process.env.MODERATION_HANDLER_FUNCTION_NAME!;

const MAX_BYTES = 5 * 1024 * 1024;
const MIN_DIMENSION = 600;
const MAX_DIMENSION = 4096;

// sharp's detected format is the magic-bytes ground truth; the extension is
// only what the client claimed. Mismatch = disguised file, reject it.
const EXT_TO_FORMAT: Record<string, string> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
};

// GIF/WEBP are rejected explicitly (distinct from "unsupported extension")
// because Rekognition's DetectModerationLabels only supports JPEG/PNG, so
// these formats can't be screened yet. Temporary until frame-extraction
// support lands (KAN-48).
const UNSCREENABLE_FORMATS: Record<string, string> = {
  gif: "GIF and WEBP are not currently supported. Please upload a JPEG or PNG.",
  webp: "GIF and WEBP are not currently supported. Please upload a JPEG or PNG.",
};

// Key format: uploads/<userId>/<pendingId>.<ext> (see app/api/upload-url).
function pendingIdFromKey(key: string): string | null {
  const match = key.match(/^uploads\/[^/]+\/([^/.]+)\.[^/.]+$/);
  return match ? match[1] : null;
}

async function markActive(pendingId: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `PENDING#${pendingId}`, SK: `PENDING#${pendingId}` },
      UpdateExpression: "SET #status = :active REMOVE reason",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":active": "active" },
    })
  );
}

async function markRejected(pendingId: string, reason: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `PENDING#${pendingId}`, SK: `PENDING#${pendingId}` },
      UpdateExpression: "SET #status = :rejected, reason = :reason",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":rejected": "rejected", ":reason": reason },
    })
  );
}

async function reject(key: string, pendingId: string, reason: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  await markRejected(pendingId, reason);
  console.log(`Rejected upload: key=${key} reason=${reason}`);
}

export const handler: S3Handler = async (event) => {
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const size = record.s3.object.size;

    const pendingId = pendingIdFromKey(key);
    if (!pendingId) {
      console.error(`Skipping key with unrecognized format: ${key}`);
      continue;
    }

    // The pending record is created before the presigned URL is issued
    // (app/api/upload-url); if it's gone, there's nothing to update.
    const pending = await docClient.send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: `PENDING#${pendingId}`, SK: `PENDING#${pendingId}` },
      })
    );
    if (!pending.Item) {
      console.error(`No pending upload record for key=${key}, deleting orphan object`);
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch((err) => {
        console.error(`Failed to delete orphan ${key}:`, err);
      });
      continue;
    }

    try {
      const ext = key.split(".").pop()?.toLowerCase() ?? "";

      if (UNSCREENABLE_FORMATS[ext]) {
        await reject(key, pendingId, UNSCREENABLE_FORMATS[ext]);
        continue;
      }

      const expectedFormat = EXT_TO_FORMAT[ext];
      if (!expectedFormat) {
        await reject(key, pendingId, `unsupported extension: ${ext}`);
        continue;
      }

      if (size > MAX_BYTES) {
        await reject(key, pendingId, `file too large: ${size} bytes (max ${MAX_BYTES})`);
        continue;
      }

      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));

      // The cleaned re-encode below overwrites this same key, which re-fires
      // this same ObjectCreated notification. Guard against that self-trigger
      // loop: an object we already validated carries this metadata flag.
      if (obj.Metadata?.validated === "true") {
        console.log(`Skipping already-validated key=${key}`);
        continue;
      }

      const buffer = Buffer.from(await obj.Body!.transformToByteArray());

      let metadata;
      try {
        metadata = await sharp(buffer).metadata();
      } catch {
        await reject(key, pendingId, "file signature does not match a supported image format");
        continue;
      }

      // Magic-bytes check: real (sniffed) format must match the claimed extension.
      if (metadata.format !== expectedFormat) {
        await reject(
          key,
          pendingId,
          `file signature (${metadata.format ?? "unknown"}) does not match extension .${ext}`
        );
        continue;
      }

      const { width = 0, height = 0 } = metadata;
      if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
        await reject(key, pendingId, `image too small: ${width}x${height} (min ${MIN_DIMENSION}px)`);
        continue;
      }
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        await reject(key, pendingId, `image too large: ${width}x${height} (max ${MAX_DIMENSION}px)`);
        continue;
      }

      // Strip EXIF (GPS, etc.) by re-encoding. sharp omits metadata by default
      // unless .withMetadata() is called, so this also normalizes the file.
      const cleaned = await sharp(buffer).toFormat(expectedFormat as keyof FormatEnum).toBuffer();
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: cleaned,
          ContentType: obj.ContentType,
          Metadata: { validated: "true" },
        })
      );

      await markActive(pendingId);
      console.log(`Validated upload: key=${key} size=${size} format=${metadata.format} dims=${width}x${height}`);

      // Fire-and-forget: ModerationHandler is invoked directly (no S3 subscription
      // of its own) now that this is the only Lambda subscribed to the bucket
      // event. A failed invoke here (throttled, unavailable) must not roll back
      // the validation that already succeeded — the image is already marked
      // active. ModerationHandlerErrorsAlarm is the backstop for catching this.
      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: MODERATION_HANDLER_FUNCTION_NAME,
            InvocationType: "Event",
            Payload: Buffer.from(JSON.stringify({ bucket: BUCKET, key })),
          })
        );
      } catch (err) {
        console.error(`Failed to invoke ModerationHandler for key=${key}:`, err);
      }
    } catch (err) {
      console.error(`Failed to process ${key}:`, err);
    }
  }
};

export { EXT_TO_FORMAT, UNSCREENABLE_FORMATS, s3, docClient, lambdaClient };
