import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getUserIdFromRequest } from "@/lib/cognito";
import { createPendingUpload, getUserById } from "@/lib/db";

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
  if (!bucket) {
    return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
  }

  const caption = request.nextUrl.searchParams.get("caption")?.trim() ?? "";
  if (!caption) {
    return NextResponse.json({ error: "caption is required" }, { status: 400 });
  }

  const rawExt = request.nextUrl.searchParams.get("ext") ?? "jpg";
  const ext = rawExt.toLowerCase().replace(/[^a-z]/g, "");
  const contentType = ALLOWED_EXTS[ext] ?? "image/jpeg";

  // uploads/ prefix matches the S3Handler validation Lambda's event filter and
  // its IAM scoping (least-privilege: activity limited to that folder only).
  const pendingId = randomUUID();
  const s3Key = `uploads/${userId}/${pendingId}.${ext}`;

  const creator = await getUserById(userId);
  await createPendingUpload({
    id: pendingId,
    creatorId: userId,
    creatorWalletAddr: creator?.walletAddr,
    s3Key,
    caption,
  });

  const presignedUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: contentType }),
    { expiresIn: 300 }
  );

  const cfDomain = process.env.CLOUDFRONT_DOMAIN;
  const imageUrl = cfDomain
    ? `https://${cfDomain}/${s3Key}`
    : `/api/image/${s3Key}`;
  return NextResponse.json({ presignedUrl, s3Key, imageUrl, pendingId });
}
