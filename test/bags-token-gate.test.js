const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// This repo has no component-render tests (see the "kill switch" tests in
// solana-network.test.js) — component behavior is verified at the data layer
// it reads, with a comment naming the component. Same approach here for the
// KAN-29 follow-up's "one token per user, UI only" rule: BagsLaunchClaim.tsx
// and app/creator/[id]/page.tsx both branch on getVerifiedBagsToken — a
// token means render BagsTokenCard, no token means render the launch button.
//
// DynamoDB client mocked per this ticket's Tests section, not a real table.
// lib/dynamo.ts still requires DYNAMODB_TABLE_NAME to exist at import time
// (it's never actually queried, since dynamo.send is mocked below), so load
// it the same way the other integration tests do.
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

test("getVerifiedBagsToken: no TOKEN# items -> null (drives the launch button)", async () => {
  const { getVerifiedBagsToken } = await import("../lib/db.ts");
  const { dynamo } = await import("../lib/dynamo.ts");
  const originalSend = dynamo.send;
  dynamo.send = async () => ({ Items: [] });
  try {
    const token = await getVerifiedBagsToken("user-1");
    assert.strictEqual(token, null);
  } finally {
    dynamo.send = originalSend;
  }
});

test("getVerifiedBagsToken: one TOKEN# item -> that token (drives the token card)", async () => {
  const { getVerifiedBagsToken } = await import("../lib/db.ts");
  const { dynamo } = await import("../lib/dynamo.ts");
  const originalSend = dynamo.send;
  dynamo.send = async () => ({
    Items: [
      {
        creatorId: "user-1",
        tokenMint: "MintA1111111111111111111111111111111111111",
        symbol: "MLRD",
        name: "Millard",
        partnerAttributed: true,
        verifiedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  try {
    const token = await getVerifiedBagsToken("user-1");
    assert.strictEqual(token.tokenMint, "MintA1111111111111111111111111111111111111");
    assert.strictEqual(token.symbol, "MLRD");
  } finally {
    dynamo.send = originalSend;
  }
});

test("getVerifiedBagsToken: multiple TOKEN# items -> the most recently verified one", async () => {
  const { getVerifiedBagsToken } = await import("../lib/db.ts");
  const { dynamo } = await import("../lib/dynamo.ts");
  const originalSend = dynamo.send;
  dynamo.send = async () => ({
    Items: [
      {
        creatorId: "user-1",
        tokenMint: "MintOld1111111111111111111111111111111111111",
        symbol: "OLD",
        name: "Old One",
        partnerAttributed: false,
        verifiedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        creatorId: "user-1",
        tokenMint: "MintNew1111111111111111111111111111111111111",
        symbol: "NEW",
        name: "New One",
        partnerAttributed: true,
        verifiedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
  try {
    const token = await getVerifiedBagsToken("user-1");
    assert.strictEqual(token.symbol, "NEW", "most recently verified wins");
  } finally {
    dynamo.send = originalSend;
  }
});
