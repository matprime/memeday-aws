import {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

interface S3EventRecord {
  s3: {
    bucket: { name: string };
    object: { key: string };
  };
}

export async function handler(event: { Records: S3EventRecord[] }): Promise<void> {
  for (const record of event.Records) {
    await processRecord(record);
  }
}

async function processRecord(record: S3EventRecord): Promise<void> {
  const bucket = record.s3.bucket.name;
  // S3 keys in events are URL-encoded with + for spaces
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

  const contentType = head.ContentType ?? "";
  const size = head.ContentLength ?? 0;

  if (!ALLOWED_TYPES.has(contentType) || size > MAX_BYTES) {
    console.log(
      `Rejecting upload: key=${key} contentType=${contentType} size=${size}`
    );
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
