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

// The route resolves the meme and checks its creator, so every bind needs a
// real row. Seeded directly — finalizeMeme's whole pending-upload path is not
// what these tests are about.
async function seedMeme(dynamo, TABLE, memeId, creatorId) {
  const { PutCommand } = require("@aws-sdk/lib-dynamodb");
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `MEME#${memeId}`,
        SK: `MEME#${memeId}`,
        memeId,
        creatorId,
        ownerId: creatorId,
        s3Key: `test/${memeId}.jpg`,
        caption: "Bags binding test meme",
        status: "active",
        createdAt: new Date().toISOString(),
      },
    })
  );
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

test("bags token binding: a token binds to one meme, and a second meme may bind its own", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { POST } = await load("app/api/bags/verify/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { randomUUID } = require("node:crypto");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  // Wallet-authenticated (KAN-75): POST /api/bags/verify now requires
  // getWalletAddressFromRequest to resolve, which only happens for a
  // Cognito username with the wallet_ prefix.
  const { accessToken, userId, cleanup } = await createTestCognitoSession(`wallet_TestBindFirst${Date.now()}`);
  const ip = `10.9.0.${Date.now() % 256}`;
  const symbolA = `A${Date.now() % 100000}`;
  const symbolB = `B${Date.now() % 100000}`;
  const memeA = randomUUID();
  const memeB = randomUUID();

  try {
    await seedMeme(dynamo, TABLE, memeA, userId);
    await seedMeme(dynamo, TABLE, memeB, userId);

    // Mock mode (this test env's devnet config) resolves a deterministic
    // SIMULATED_<symbol> mint — see verifyBagsLaunch in lib/bags-server.ts.
    const first = await POST(
      verifyRequest(accessToken, ip, { memeId: memeA, name: "First Token", symbol: symbolA })
    );
    assert.strictEqual(first.status, 200, "first bind should succeed");
    const firstBody = await first.json();
    assert.strictEqual(firstBody.token.tokenMint, `SIMULATED_${symbolA}`);

    const { Item } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `TOKEN#${memeA}` } })
    );
    assert.ok(Item, "expected an item at SK TOKEN#<memeId>");
    assert.strictEqual(Item.tokenMint, `SIMULATED_${symbolA}`, "tokenMint lives in the attribute, not the key");
    assert.strictEqual(Item.memeId, memeA);

    // Re-submit the same resolved mint (same symbol -> same SIMULATED_ mint).
    const retry = await POST(
      verifyRequest(accessToken, ip, { memeId: memeA, name: "First Token", symbol: symbolA })
    );
    assert.strictEqual(retry.status, 200, "a same-mint retry should be a safe no-op, not an error");
    const retryBody = await retry.json();
    assert.strictEqual(retryBody.token.tokenMint, firstBody.token.tokenMint);
    assert.strictEqual(retryBody.token.verifiedAt, firstBody.token.verifiedAt, "verifiedAt must not be rewritten");

    // A different mint on the SAME meme must be rejected — that binding is
    // still permanent.
    const conflict = await POST(
      verifyRequest(accessToken, ip, { memeId: memeA, name: "Second Token", symbol: symbolB })
    );
    assert.strictEqual(conflict.status, 409, "a different mint on a bound meme must be rejected");

    // The KAN-11 point: another meme is free to launch its own token.
    const second = await POST(
      verifyRequest(accessToken, ip, { memeId: memeB, name: "Second Token", symbol: symbolB })
    );
    assert.strictEqual(second.status, 200, "a second meme must be able to bind its own token");
    assert.strictEqual((await second.json()).token.tokenMint, `SIMULATED_${symbolB}`);

    const { Item: after } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `TOKEN#${memeA}` } })
    );
    assert.strictEqual(after.tokenMint, `SIMULATED_${symbolA}`, "the original binding must be unchanged");
    assert.strictEqual(after.verifiedAt, firstBody.token.verifiedAt, "the original binding must be unchanged");
  } finally {
    // DynamoDB cleanup first, Cognito cleanup last: AdminDeleteUser is known
    // to fail with AccessDenied in this local dev env (same gap the
    // pre-existing email-login.test.js/session-refresh.test.js hit, KAN-54),
    // and a throw there must not skip deleting the DynamoDB items above it.
    for (const memeId of [memeA, memeB]) {
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `TOKEN#${memeId}` } }));
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } }));
    }
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

// Per-meme binding would otherwise be free to defeat: one mint pasted on every
// meme would claim them all for the same token.
test("bags token binding: one mint cannot be claimed by a second meme", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { POST } = await load("app/api/bags/verify/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { randomUUID } = require("node:crypto");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  const { accessToken, userId, cleanup } = await createTestCognitoSession(`wallet_TestBindReuse${Date.now()}`);
  const ip = `10.9.2.${Date.now() % 256}`;
  const symbol = `R${Date.now() % 100000}`;
  const memeA = randomUUID();
  const memeB = randomUUID();

  try {
    await seedMeme(dynamo, TABLE, memeA, userId);
    await seedMeme(dynamo, TABLE, memeB, userId);

    const first = await POST(verifyRequest(accessToken, ip, { memeId: memeA, name: "Token", symbol }));
    assert.strictEqual(first.status, 200);

    const reuse = await POST(verifyRequest(accessToken, ip, { memeId: memeB, name: "Token", symbol }));
    assert.strictEqual(reuse.status, 409, "the same mint must not bind to a second meme");
  } finally {
    for (const memeId of [memeA, memeB]) {
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `TOKEN#${memeId}` } }));
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } }));
    }
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

// Only the uploader may bind a meme's token (KAN-11), checked against the meme
// row rather than anything the caller claims.
test("bags token binding: a caller who did not upload the meme is refused", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { POST } = await load("app/api/bags/verify/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { randomUUID } = require("node:crypto");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  const { accessToken, userId, cleanup } = await createTestCognitoSession(`wallet_TestBindOther${Date.now()}`);
  const ip = `10.9.3.${Date.now() % 256}`;
  const memeId = randomUUID();

  try {
    await seedMeme(dynamo, TABLE, memeId, `someone-else-${Date.now()}`);

    const res = await POST(
      verifyRequest(accessToken, ip, { memeId, name: "Not Mine", symbol: `X${Date.now() % 100000}` })
    );
    assert.strictEqual(res.status, 403, "only the meme's creator may bind its token");

    const { Item } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `TOKEN#${memeId}` } })
    );
    assert.strictEqual(Item, undefined, "nothing may be written for a meme the caller did not upload");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } }));
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

// A creator who bound a token before per-meme binding keeps it on their
// profile, but it no longer follows them onto a new meme — that stale card on
// every later success screen is what KAN-11 reported.
test("bags token binding: a pre-KAN-11 creator-level row does not block a new meme's launch", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { POST } = await load("app/api/bags/verify/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { PutCommand, DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { randomUUID } = require("node:crypto");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  const { accessToken, userId, cleanup } = await createTestCognitoSession(`wallet_TestBindLegacy${Date.now()}`);
  const ip = `10.9.1.${Date.now() % 256}`;
  const legacyMint = `LegacyMint1111111111111111111111111111${Date.now() % 100000}`.slice(0, 44);
  const newSymbol = `L${Date.now() % 100000}`;
  const memeId = randomUUID();

  // Seed a pre-KAN-11 row directly: SK = TOKEN#PRIMARY, no memeId attribute.
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USER#${userId}`,
        SK: "TOKEN#PRIMARY",
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
    await seedMeme(dynamo, TABLE, memeId, userId);

    const res = await POST(
      verifyRequest(accessToken, ip, { memeId, name: "New Token", symbol: newSymbol })
    );
    assert.strictEqual(res.status, 200, "a legacy creator-level row must not block a new meme's own token");

    const { Item } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `TOKEN#${memeId}` } })
    );
    assert.strictEqual(Item.tokenMint, `SIMULATED_${newSymbol}`);

    const { Item: legacy } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: "TOKEN#PRIMARY" } })
    );
    assert.strictEqual(legacy.tokenMint, legacyMint, "the legacy row is left exactly as it was");
  } finally {
    // See the first test: DynamoDB cleanup before Cognito cleanup.
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: "TOKEN#PRIMARY" } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `TOKEN#${memeId}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } }));
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
