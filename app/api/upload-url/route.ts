import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getUserIdFromRequest } from "@/lib/cognito";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

const ALLOWED_EXTS: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

export async function GET(request: NextRequest) {
  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bucket = process.env.S3_BUCKET_NAME;
  const cfDomain = process.env.CLOUDFRONT_DOMAIN;
  if (!bucket || !cfDomain) {
    return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
  }

  const rawExt = request.nextUrl.searchParams.get("ext") ?? "jpg";
  const ext = rawExt.toLowerCase().replace(/[^a-z]/g, "");
  const contentType = ALLOWED_EXTS[ext] ?? "image/jpeg";

  const s3Key = `${userId}/${Date.now()}.${ext}`;
  const presignedUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: contentType }),
    { expiresIn: 300 }
  );

  const imageUrl = `https://${cfDomain}/${s3Key}`;
  return NextResponse.json({ presignedUrl, s3Key, imageUrl });
}
