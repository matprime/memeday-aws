// Temporary S3 image proxy — used when CLOUDFRONT_DOMAIN is not set.
// Remove once AWS support enables CloudFront and cfUrl() returns real CF URLs.
import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

// Expected key shape: <userId>/<timestamp>.<ext> — exactly two segments.
const SAFE_KEY = /^[^/]+\/\d+\.(jpg|jpeg|png|gif|webp)$/i;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
) {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) {
    return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
  }

  const { key } = await params;
  const s3Key = key.join("/");

  if (!SAFE_KEY.test(s3Key)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = s3Key.split(".").pop()!.toLowerCase();
  const contentType = EXT_TO_MIME[ext] ?? "image/jpeg";

  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
    const body = await res.Body!.transformToByteArray();
    return new Response(body.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
