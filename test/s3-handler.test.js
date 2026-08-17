const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// .env.local overrides .env, same precedence Next.js uses.
for (const envFile of [".env.local", ".env"]) {
  const envPath = path.join(__dirname, "..", envFile);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/cache") {
      const stub = path.join(__dirname, "helpers", "next-cache-stub.mjs");
      return { url: pathToFileURL(stub).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

// Rekognition's generic block-reason string (lambdas/moderation-handler/index.ts
// applyBlockDecision) — the GIF/WEBP format reason must never collide with it.
const REKOGNITION_GENERIC_REASON = "Content does not meet our community guidelines.";

// handler() itself checks UNSCREENABLE_FORMATS before EXT_TO_FORMAT, before any
// S3 GetObject/sharp/Rekognition call — so these exported maps alone fully
// determine the gif/webp rejection behavior described in the ticket. Full
// live handler() invocation isn't exercised here: it needs S3 GetObject/
// DeleteObject permissions the local dev IAM user doesn't have (see
// test/upload.test.js, which only ever does presigned PUT for the same
// reason). DynamoDB status-transition coverage for this pending-record flow
// already exists in test/pending-upload.test.js.

test("EXT_TO_FORMAT: gif and webp are no longer accepted formats", async () => {
  const { EXT_TO_FORMAT } = await import("../lambdas/s3-handler/index.ts");
  assert.strictEqual(EXT_TO_FORMAT.gif, undefined);
  assert.strictEqual(EXT_TO_FORMAT.webp, undefined);
});

test("EXT_TO_FORMAT: jpg/jpeg/png are unaffected", async () => {
  const { EXT_TO_FORMAT } = await import("../lambdas/s3-handler/index.ts");
  assert.strictEqual(EXT_TO_FORMAT.jpg, "jpeg");
  assert.strictEqual(EXT_TO_FORMAT.jpeg, "jpeg");
  assert.strictEqual(EXT_TO_FORMAT.png, "png");
});

test("UNSCREENABLE_FORMATS: gif and webp carry a specific, honest, non-generic reason", async () => {
  const { UNSCREENABLE_FORMATS } = await import("../lambdas/s3-handler/index.ts");

  for (const ext of ["gif", "webp"]) {
    const reason = UNSCREENABLE_FORMATS[ext];
    assert.ok(reason, `${ext} has a rejection reason`);
    assert.doesNotMatch(reason, /unsupported extension/i, `${ext} reason is distinct from the generic unsupported-extension message`);
    assert.notStrictEqual(reason, REKOGNITION_GENERIC_REASON, `${ext} reason is distinct from the Rekognition generic content-policy message`);
    assert.doesNotMatch(reason, /rekognition|moderat|screen/i, `${ext} reason does not mention moderation/screening/Rekognition`);
  }
});

test("UNSCREENABLE_FORMATS: jpg/jpeg/png are not gated here — they fall through to normal validation", async () => {
  const { UNSCREENABLE_FORMATS } = await import("../lambdas/s3-handler/index.ts");
  assert.strictEqual(UNSCREENABLE_FORMATS.jpg, undefined);
  assert.strictEqual(UNSCREENABLE_FORMATS.jpeg, undefined);
  assert.strictEqual(UNSCREENABLE_FORMATS.png, undefined);
});
