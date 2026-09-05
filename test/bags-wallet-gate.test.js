const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { hasAwsCredentials } = require("./helpers/aws-credentials");
const { createTestCognitoSession } = require("./helpers/test-auth");

// .env.local overrides .env, same precedence Next.js uses — dev credentials/table names live there.
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
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(__dirname, "..", specifier.slice(2) + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
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

function load(rel) {
  return import(pathToFileURL(path.join(__dirname, "..", rel)).href);
}

function skipIfNoCredentials(t) {
  if (
    !process.env.DYNAMODB_TABLE_NAME ||
    !process.env.COGNITO_USER_POOL_ID ||
    !process.env.COGNITO_CLIENT_ID ||
    !hasAwsCredentials()
  ) {
    t.skip("Missing DYNAMODB_TABLE_NAME, Cognito config, or AWS credentials");
    return true;
  }
  return false;
}

async function cleanupRateCounter(dynamo, TABLE, RATE_LIMITS, limitName, identity) {
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const windowStart =
    Math.floor(Date.now() / 1000 / RATE_LIMITS[limitName].windowSeconds) * RATE_LIMITS[limitName].windowSeconds;
  await dynamo.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: `RATE#${identity}`, SK: `${RATE_LIMITS[limitName].key}#${windowStart}` },
    })
  );
}

// ── GET /api/bags/launch-config: gains auth, walletAuthed comes from the token (KAN-75) ──
// BagsLaunchClaim.tsx's handleLaunch reads this field to decide whether to
// proceed at all — that's the "component" half of this ticket's launch-gate
// coverage; this repo has no component-render tests (see bags-token-gate.test.js),
// so the contract the component reads is what's pinned here.

test("launch-config: no Authorization header is unauthorized", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { GET } = await load("app/api/bags/launch-config/route.ts");
  const res = await GET(new Request("http://x/api/bags/launch-config"));
  assert.strictEqual(res.status, 401);
});

test("launch-config: an email-authenticated (non-wallet) caller gets walletAuthed: false, and live:false without reading Bags env vars", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { GET } = await load("app/api/bags/launch-config/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  const session = await createTestCognitoSession(`test-launchcfg-email-${Date.now()}`);
  try {
    const res = await GET(
      new Request("http://x/api/bags/launch-config", {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      })
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.walletAuthed, false, "email session has no wallet_ username prefix");
    assert.strictEqual(body.live, false, "devnet test env must never regress to live:true");
    assert.strictEqual(body.partnerWallet, undefined, "off mainnet, no Bags secret is ever read or returned");
  } finally {
    await session.cleanup();
    await cleanupRateCounter(dynamo, TABLE, RATE_LIMITS, "bagsLaunchConfigPerUser", session.userId);
  }
});

test("launch-config: a wallet-authenticated caller gets walletAuthed: true", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { GET } = await load("app/api/bags/launch-config/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  const walletAddress = `TestLaunchCfgWallet${Date.now()}`;
  const session = await createTestCognitoSession(`wallet_${walletAddress}`);
  try {
    const res = await GET(
      new Request("http://x/api/bags/launch-config", {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      })
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.walletAuthed, true);
  } finally {
    await session.cleanup();
    await cleanupRateCounter(dynamo, TABLE, RATE_LIMITS, "bagsLaunchConfigPerUser", session.userId);
  }
});

// ── POST /api/bags/verify: wallet-only gate, applies in simulated mode too (KAN-75) ──

test("bags/verify: an email-authenticated (non-wallet) caller is rejected before any Bags call, even in simulated mode", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { POST } = await load("app/api/bags/verify/route.ts");
  const { isBagsLiveModeEnabled } = await load("lib/bags-server.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  assert.strictEqual(isBagsLiveModeEnabled(), false, "this test's env must be devnet — simulated branch is what's being gated");

  const session = await createTestCognitoSession(`test-verify-email-${Date.now()}`);
  try {
    const res = await POST(
      new Request("http://x/api/bags/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
          "x-forwarded-for": `test-verify-email-ip-${Date.now()}`,
        },
        body: JSON.stringify({ name: "My Token", symbol: "MLRD" }),
      })
    );
    assert.strictEqual(res.status, 403);

    const { QueryCommand } = require("@aws-sdk/lib-dynamodb");
    const { Items } = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": `USER#${session.userId}`, ":prefix": "TOKEN#" },
      })
    );
    assert.strictEqual((Items ?? []).length, 0, "a rejected caller must never get a stored TOKEN# item");
  } finally {
    await session.cleanup();
  }
});

test("bags/verify: a wallet-authenticated caller passes the gate and gets a simulated verification off mainnet", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { POST } = await load("app/api/bags/verify/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  const walletAddress = `TestVerifyWallet${Date.now()}`;
  const session = await createTestCognitoSession(`wallet_${walletAddress}`);
  const ip = `test-verify-wallet-ip-${Date.now()}`;
  try {
    const res = await POST(
      new Request("http://x/api/bags/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ name: "My Token", symbol: "MLRD" }),
      })
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.simulated, true);
    assert.match(body.token.tokenMint, /^SIMULATED_MLRD$/);
  } finally {
    const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `USER#${session.userId}`, SK: "TOKEN#SIMULATED_MLRD" },
      })
    );
    await cleanupRateCounter(dynamo, TABLE, RATE_LIMITS, "bagsVerifyPerUser", session.userId);
    await cleanupRateCounter(dynamo, TABLE, RATE_LIMITS, "bagsVerifyPerIp", ip);
    await session.cleanup();
  }
});
