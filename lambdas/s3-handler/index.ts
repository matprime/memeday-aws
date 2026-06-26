import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { S3Handler } from "aws-lambda";

const s3 = new S3Client({});
const BUCKET = process.env.S3_BUCKET_NAME!;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

export const handler: S3Handler = async (event) => {
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const size = record.s3.object.size;
    const ext = key.split(".").pop()?.toLowerCase() ?? "";

    if (size <= MAX_BYTES && ALLOWED_EXTS.has(ext)) continue;

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      console.log(`Deleted invalid upload: key=${key} size=${size} ext=${ext}`);
    } catch (err) {
      console.error(`Failed to delete ${key}:`, err);
    }
  }
};
