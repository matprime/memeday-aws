const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// Load .env so the S3 client gets bucket name, region, and credentials.
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

// Minimal valid 1×1 transparent PNG (hardcoded bytes — no file I/O needed).
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
  "01f15c4890000000a4944415478016360000000020001e221bc33000000004945" +
  "4e44ae426082",
  "hex"
);

test("upload: presigned PUT URL is generated and S3 accepts the upload", async (t) => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket || !process.env.AWS_ACCESS_KEY_ID) {
    t.skip("Missing S3_BUCKET_NAME or AWS credentials");
    return;
  }

  const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } =
    require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

  const s3 = new S3Client({ region: process.env.AWS_REGION ?? "eu-west-1" });
  const s3Key = `test/upload-test-${Date.now()}.png`;

  // Generate a presigned PUT URL (same logic as /api/upload-url).
  const presignedUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: "image/png" }),
    { expiresIn: 60 }
  );
  assert.ok(presignedUrl.startsWith("https://"), "presigned URL should be https");

  try {
    // PUT the image directly to S3 — this is what the browser does.
    const putRes = await fetch(presignedUrl, {
      method: "PUT",
      body: PNG_1X1,
      headers: { "Content-Type": "image/png" },
    });
    assert.strictEqual(putRes.status, 200, `S3 PUT failed with status ${putRes.status}`);

    // Verify the object landed in the bucket with the right metadata.
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));
    assert.strictEqual(head.ContentType, "image/png", "stored content-type should be image/png");
    assert.ok((head.ContentLength ?? 0) > 0, "stored object should have non-zero size");
  } finally {
    // Clean up regardless of pass/fail.
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key })).catch(() => {});
  }
});
