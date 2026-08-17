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

// Not deployed by any real env file yet (new in this change) — pin a
// deterministic value so tests can assert on it.
process.env.MODERATION_HANDLER_FUNCTION_NAME ??= "moderation-handler-test-fn";

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

// --- handler(): S3/DynamoDB/Lambda clients mocked by swapping .send on the
// exported client instances — no live AWS calls, per the project's rule.
// sharp itself is real (it's a local image library, not an AWS call).

function mockSend(client, handlers) {
  const original = client.send;
  client.send = async (cmd) => {
    const fn = handlers[cmd.constructor.name];
    if (!fn) throw new Error(`Unexpected command: ${cmd.constructor.name}`);
    return fn(cmd);
  };
  return () => {
    client.send = original;
  };
}

test("S3Handler: successful validation invokes ModerationHandler with the bucket/key it just validated", async () => {
  const sharp = require("sharp");
  const { handler, s3, docClient, lambdaClient } = await import("../lambdas/s3-handler/index.ts");

  const key = "uploads/test-user/success-abc.png";
  const validImage = await sharp({
    create: { width: 600, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();

  const invokeCalls = [];
  const restoreS3 = mockSend(s3, {
    GetObjectCommand: async () => ({
      Body: { transformToByteArray: async () => validImage },
      ContentType: "image/png",
      Metadata: {},
    }),
    PutObjectCommand: async () => ({}),
    DeleteObjectCommand: async () => ({}),
  });
  const restoreDoc = mockSend(docClient, {
    GetCommand: async () => ({ Item: { PK: "PENDING#success-abc", SK: "PENDING#success-abc", status: "pending" } }),
    UpdateCommand: async () => ({}),
  });
  const restoreLambda = mockSend(lambdaClient, {
    InvokeCommand: async (cmd) => {
      invokeCalls.push(cmd.input);
      return {};
    },
  });

  try {
    await handler({ Records: [{ s3: { object: { key, size: validImage.length } } }] }, {}, () => {});
  } finally {
    restoreS3();
    restoreDoc();
    restoreLambda();
  }

  assert.strictEqual(invokeCalls.length, 1, "ModerationHandler is invoked exactly once after successful validation");
  assert.strictEqual(invokeCalls[0].InvocationType, "Event", "fire-and-forget, does not await a response payload");
  assert.strictEqual(invokeCalls[0].FunctionName, process.env.MODERATION_HANDLER_FUNCTION_NAME);
  const payload = JSON.parse(Buffer.from(invokeCalls[0].Payload).toString());
  assert.strictEqual(payload.key, key, "handoff payload carries the key S3Handler just validated");
  assert.ok(payload.bucket, "handoff payload carries the bucket");
});

test("S3Handler: rejected upload (fails validation) never invokes ModerationHandler", async () => {
  const { handler, s3, docClient, lambdaClient } = await import("../lambdas/s3-handler/index.ts");

  // Minimal valid 1×1 PNG — passes the magic-bytes check but fails the
  // MIN_DIMENSION=600 check, so it's rejected before any re-encode/markActive.
  const PNG_1X1 = Buffer.from(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
      "01f15c4890000000a4944415478016360000000020001e221bc33000000004945" +
      "4e44ae426082",
    "hex"
  );
  const key = "uploads/test-user/reject-def.png";

  const invokeCalls = [];
  const restoreS3 = mockSend(s3, {
    GetObjectCommand: async () => ({
      Body: { transformToByteArray: async () => PNG_1X1 },
      ContentType: "image/png",
      Metadata: {},
    }),
    DeleteObjectCommand: async () => ({}),
  });
  const restoreDoc = mockSend(docClient, {
    GetCommand: async () => ({ Item: { PK: "PENDING#reject-def", SK: "PENDING#reject-def", status: "pending" } }),
    UpdateCommand: async () => ({}),
  });
  const restoreLambda = mockSend(lambdaClient, {
    InvokeCommand: async (cmd) => {
      invokeCalls.push(cmd.input);
      return {};
    },
  });

  try {
    await handler({ Records: [{ s3: { object: { key, size: PNG_1X1.length } } }] }, {}, () => {});
  } finally {
    restoreS3();
    restoreDoc();
    restoreLambda();
  }

  assert.strictEqual(invokeCalls.length, 0, "a rejected file never triggers moderation");
});
