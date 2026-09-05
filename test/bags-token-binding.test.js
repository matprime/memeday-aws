const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { hasAwsCredentials } = require("./helpers/aws-credentials");
const { createTestCognitoSession } = require("./helpers/test-auth");

// Same .env loading as the other integration tests (see voting-enforcement.test.js).
for (const envFile of [".env.local", ".env"]) {
  const envPath = path.join(__dirname, "..", envFile);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  }
}

// Same resolver hooks as report.test.js: "@/..." path alias, next/server,
// next/cache stub, and extensionless relative imports.
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

function verifyRequest(accessToken, ip, body) {
  return new Request("http://localhost/api/bags/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      // Unique per test so bagsVerifyPerIp (20/day) never collides across
      // test runs sharing the same window — bagsVerifyPerUser is naturally
      // unique already since each test creates its own Cognito user.
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

test("bags token binding: first bind writes TOKEN#PRIMARY, a same-mint retry is a safe no-op, a different mint is rejected", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { POST } = await load("app/api/bags/verify/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  // Wallet-authenticated (KAN-75): POST /api/bags/verify now requires
  // getWalletAddressFromRequest to resolve, which only happens for a
  // Cognito username with the wallet_ prefix.
  const { accessToken, userId, cleanup } = await createTestCognitoSession(`wallet_TestBindFirst${Date.now()}`);
  const ip = `10.9.0.${Date.now() % 256}`;
  const symbolA = `A${Date.now() % 100000}`;
  const symbolB = `B${Date.now() % 100000}`;

  try {
    // Mock mode (this test env's devnet config) resolves a deterministic
    // SIMULATED_<symbol> mint — see verifyBagsLaunch in lib/bags-server.ts.
    const first = await POST(verifyRequest(accessToken, ip, { name: "First Token", symbol: symbolA }));
    assert.strictEqual(first.status, 200, "first bind should succeed");
    const firstBody = await first.json();
    assert.strictEqual(firstBody.token.tokenMint, `SIMULATED_${symbolA}`);

    const { Item } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: "TOKEN#PRIMARY" } })
    );
    assert.ok(Item, "expected an item at SK TOKEN#PRIMARY");
    assert.strictEqual(Item.tokenMint, `SIMULATED_${symbolA}`, "tokenMint lives in the attribute, not the key");

    // Re-submit the same resolved mint (same symbol -> same SIMULATED_ mint).
    const retry = await POST(verifyRequest(accessToken, ip, { name: "First Token", symbol: symbolA }));
    assert.strictEqual(retry.status, 200, "a same-mint retry should be a safe no-op, not an error");
    const retryBody = await retry.json();
    assert.strictEqual(retryBody.token.tokenMint, firstBody.token.tokenMint);
    assert.strictEqual(retryBody.token.verifiedAt, firstBody.token.verifiedAt, "verifiedAt must not be rewritten");

    // A different mint (different symbol) must be rejected.
    const conflict = await POST(verifyRequest(accessToken, ip, { name: "Second Token", symbol: symbolB }));
    assert.strictEqual(conflict.status, 409, "a different mint must be rejected — the binding is permanent");

    const { Item: after } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: "TOKEN#PRIMARY" } })
    );
    assert.strictEqual(after.tokenMint, `SIMULATED_${symbolA}`, "the original binding must be unchanged");
    assert.strictEqual(after.verifiedAt, firstBody.token.verifiedAt, "the original binding must be unchanged");
  } finally {
    // DynamoDB cleanup first, Cognito cleanup last: AdminDeleteUser is known
    // to fail with AccessDenied in this local dev env (same gap the
    // pre-existing email-login.test.js/session-refresh.test.js hit, KAN-54),
    // and a throw there must not skip deleting the DynamoDB items above it.
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: "TOKEN#PRIMARY" } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `USER#${userId}` } }));
    const windowStart =
      Math.floor(Date.now() / 1000 / RATE_LIMITS.bagsVerifyPerUser.windowSeconds) * RATE_LIMITS.bagsVerifyPerUser.windowSeconds;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `RATE#${userId}`, SK: `bagsVerifyPerUser#${windowStart}` } }));
    const ipWindowStart =
      Math.floor(Date.now() / 1000 / RATE_LIMITS.bagsVerifyPerIp.windowSeconds) * RATE_LIMITS.bagsVerifyPerIp.windowSeconds;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `RATE#${ip}`, SK: `bagsVerifyPerIp#${ipWindowStart}` } }));
    await cleanup();
  }
});

test("bags token binding: a legacy TOKEN#<mint> row with no TOKEN#PRIMARY is rejected by the route pre-check", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { POST } = await load("app/api/bags/verify/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { PutCommand, DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  // Wallet-authenticated (KAN-75): see the first test above for why.
  const { accessToken, userId, cleanup } = await createTestCognitoSession(`wallet_TestBindLegacy${Date.now()}`);
  const ip = `10.9.1.${Date.now() % 256}`;
  const legacyMint = `LegacyMint1111111111111111111111111111${Date.now() % 100000}`.slice(0, 44);
  const newSymbol = `L${Date.now() % 100000}`;

  // Seed a pre-KAN-79 row directly: SK = TOKEN#<mint>, no TOKEN#PRIMARY item,
  // simulating a creator who bound before this change.
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USER#${userId}`,
        SK: `TOKEN#${legacyMint}`,
        creatorId: userId,
        tokenMint: legacyMint,
        symbol: "LEGACY",
        name: "Legacy Token",
        partnerAttributed: true,
        verifiedAt: new Date().toISOString(),
      },
    })
  );

  try {
    const res = await POST(verifyRequest(accessToken, ip, { name: "New Token", symbol: newSymbol }));
    assert.strictEqual(res.status, 409, "a legacy TOKEN#<mint> row must still block a new bind via the pre-check");

    const { Item: primary } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: "TOKEN#PRIMARY" } })
    );
    assert.strictEqual(primary, undefined, "the DB condition alone would not have caught this — no TOKEN#PRIMARY should exist");
  } finally {
    // See the previous test: DynamoDB cleanup before Cognito cleanup.
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `TOKEN#${legacyMint}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `USER#${userId}` } }));
    const windowStart =
      Math.floor(Date.now() / 1000 / RATE_LIMITS.bagsVerifyPerUser.windowSeconds) * RATE_LIMITS.bagsVerifyPerUser.windowSeconds;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `RATE#${userId}`, SK: `bagsVerifyPerUser#${windowStart}` } }));
    const ipWindowStart =
      Math.floor(Date.now() / 1000 / RATE_LIMITS.bagsVerifyPerIp.windowSeconds) * RATE_LIMITS.bagsVerifyPerIp.windowSeconds;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `RATE#${ip}`, SK: `bagsVerifyPerIp#${ipWindowStart}` } }));
    await cleanup();
  }
});
