const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { hasAwsCredentials } = require("./helpers/aws-credentials");
const { createTestCognitoSession, generateTestWallet, signChallenge } = require("./helpers/test-auth");

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
    !process.env.WALLET_AUTH_SECRET ||
    !hasAwsCredentials()
  ) {
    t.skip("Missing DYNAMODB_TABLE_NAME, Cognito config, WALLET_AUTH_SECRET, or AWS credentials");
    return true;
  }
  return false;
}

async function getUserItem(dynamo, TABLE, userId) {
  const { GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { Item } = await dynamo.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `USER#${userId}` } })
  );
  return Item;
}

async function deleteUserItem(dynamo, TABLE, userId) {
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `USER#${userId}` } }));
}

// Real challenges via the actual nonce route, same as the app does — this
// also exercises verifyChallenge/verifySolanaSignature post-move (lib/wallet-
// signature.ts), so a regression from the KAN-75 extraction would show up
// here as well as in the wallet-login test coverage.
async function requestChallenge(POSTnonce, walletAddress, ip) {
  const res = await POSTnonce(
    new Request("http://x/api/auth/wallet/nonce", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ walletAddress }),
    })
  );
  const { challenge } = await res.json();
  return challenge;
}

// ── POST /api/users: walletAddr from the body is ignored (KAN-75) ──────────

test("POST /api/users: a wallet-authenticated caller's walletAddr comes from the token, not the body", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { POST } = await load("app/api/users/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");

  const walletAddress = `TestUsersRouteWallet${Date.now()}`;
  const session = await createTestCognitoSession(`wallet_${walletAddress}`);
  try {
    const res = await POST(
      new Request("http://x/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ walletAddr: "AttackerSuppliedAddress1111111111111111111" }),
      })
    );
    assert.strictEqual(res.status, 200);
    const { user } = await res.json();
    assert.strictEqual(user.walletAddr, walletAddress, "walletAddr is the token's proven address, never the body's");
  } finally {
    await deleteUserItem(dynamo, TABLE, session.userId);
    await session.cleanup();
  }
});

test("POST /api/users: an email-authenticated caller's body-supplied walletAddr is ignored, not an error", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { POST } = await load("app/api/users/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");

  const session = await createTestCognitoSession(`test-users-route-email-${Date.now()}`);
  try {
    const res = await POST(
      new Request("http://x/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ walletAddr: "SomeAddressTheClientAsserted1111111111111" }),
      })
    );
    assert.strictEqual(res.status, 200, "an older client sending walletAddr must not error");
    const { user } = await res.json();
    assert.strictEqual(user.walletAddr, undefined, "no proven wallet on the token means nothing is written");

    const item = await getUserItem(dynamo, TABLE, session.userId);
    assert.strictEqual(item.walletAddr, undefined, "walletAddr attribute is absent from the row itself");
    assert.strictEqual(item.GSI2PK, undefined, "no GSI2 WALLET# key is written either");
  } finally {
    await deleteUserItem(dynamo, TABLE, session.userId);
    await session.cleanup();
  }
});

// ── POST /api/users/wallet: link route (KAN-75) ─────────────────────────────

test("POST /api/users/wallet: a valid challenge and signature link the wallet", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { POST: postLink } = await load("app/api/users/wallet/route.ts");
  const { POST: postNonce } = await load("app/api/auth/wallet/nonce/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  const wallet = generateTestWallet();
  const session = await createTestCognitoSession(`test-link-good-${Date.now()}`);
  const ip = `test-link-good-ip-${Date.now()}`;
  try {
    const challenge = await requestChallenge(postNonce, wallet.walletAddress, ip);
    const signature = signChallenge(wallet.privateKey, challenge);

    const res = await postLink(
      new Request("http://x/api/users/wallet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ walletAddress: wallet.walletAddress, challenge, signature }),
      })
    );
    assert.strictEqual(res.status, 200);
    const { user } = await res.json();
    assert.strictEqual(user.walletAddr, wallet.walletAddress);

    const item = await getUserItem(dynamo, TABLE, session.userId);
    assert.strictEqual(item.walletAddr, wallet.walletAddress);
    assert.strictEqual(item.GSI2PK, `WALLET#${wallet.walletAddress}`);
  } finally {
    await deleteUserItem(dynamo, TABLE, session.userId);
    const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
    const windowStart = (name) =>
      Math.floor(Date.now() / 1000 / RATE_LIMITS[name].windowSeconds) * RATE_LIMITS[name].windowSeconds;
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `RATE#${session.userId}`, SK: `walletLinkPerUser#${windowStart("walletLinkPerUser")}` },
      })
    );
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `RATE#${ip}`, SK: `walletLinkPerIp#${windowStart("walletLinkPerIp")}` },
      })
    );
    await session.cleanup();
  }
});

test("POST /api/users/wallet: a bad signature is rejected and writes nothing", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { POST: postLink } = await load("app/api/users/wallet/route.ts");
  const { POST: postNonce } = await load("app/api/auth/wallet/nonce/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");

  const wallet = generateTestWallet();
  const otherWallet = generateTestWallet();
  const session = await createTestCognitoSession(`test-link-badsig-${Date.now()}`);
  const ip = `test-link-badsig-ip-${Date.now()}`;
  try {
    const challenge = await requestChallenge(postNonce, wallet.walletAddress, ip);
    // Signed with the wrong key entirely — verifySolanaSignature must fail.
    const signature = signChallenge(otherWallet.privateKey, challenge);

    const res = await postLink(
      new Request("http://x/api/users/wallet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ walletAddress: wallet.walletAddress, challenge, signature }),
      })
    );
    assert.strictEqual(res.status, 401);

    const item = await getUserItem(dynamo, TABLE, session.userId);
    assert.strictEqual(item, undefined, "a rejected link must not create or touch the user row");
  } finally {
    await deleteUserItem(dynamo, TABLE, session.userId);
    const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
    const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");
    const windowStart = (name) =>
      Math.floor(Date.now() / 1000 / RATE_LIMITS[name].windowSeconds) * RATE_LIMITS[name].windowSeconds;
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `RATE#${session.userId}`, SK: `walletLinkPerUser#${windowStart("walletLinkPerUser")}` },
      })
    );
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `RATE#${ip}`, SK: `walletLinkPerIp#${windowStart("walletLinkPerIp")}` },
      })
    );
    await session.cleanup();
  }
});

test("POST /api/users/wallet: an expired challenge is rejected", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { POST: postLink } = await load("app/api/users/wallet/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");

  const wallet = generateTestWallet();
  const session = await createTestCognitoSession(`test-link-expired-${Date.now()}`);
  const ip = `test-link-expired-ip-${Date.now()}`;
  try {
    // Hand-build a challenge with a timestamp 6 minutes old — past the 5-minute
    // TTL enforced in lib/wallet-signature.ts verifyChallenge, moved verbatim
    // from app/api/auth/wallet/verify/route.ts.
    const staleTs = Date.now() - 6 * 60 * 1000;
    const nonce = `${staleTs}:${wallet.walletAddress}:deadbeef`;
    const hmac = createHmac("sha256", process.env.WALLET_AUTH_SECRET).update(nonce).digest("hex");
    const challenge = `${nonce}.${hmac}`;
    const signature = signChallenge(wallet.privateKey, challenge);

    const res = await postLink(
      new Request("http://x/api/users/wallet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ walletAddress: wallet.walletAddress, challenge, signature }),
      })
    );
    assert.strictEqual(res.status, 401);

    const item = await getUserItem(dynamo, TABLE, session.userId);
    assert.strictEqual(item, undefined);
  } finally {
    await deleteUserItem(dynamo, TABLE, session.userId);
    const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
    const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");
    const windowStart = (name) =>
      Math.floor(Date.now() / 1000 / RATE_LIMITS[name].windowSeconds) * RATE_LIMITS[name].windowSeconds;
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `RATE#${session.userId}`, SK: `walletLinkPerUser#${windowStart("walletLinkPerUser")}` },
      })
    );
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `RATE#${ip}`, SK: `walletLinkPerIp#${windowStart("walletLinkPerIp")}` },
      })
    );
    await session.cleanup();
  }
});

test("POST /api/users/wallet: an address that does not match the challenge is rejected", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { POST: postLink } = await load("app/api/users/wallet/route.ts");
  const { POST: postNonce } = await load("app/api/auth/wallet/nonce/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");

  const wallet = generateTestWallet();
  const claimedWallet = generateTestWallet();
  const session = await createTestCognitoSession(`test-link-mismatch-${Date.now()}`);
  const ip = `test-link-mismatch-ip-${Date.now()}`;
  try {
    // Challenge is issued for `wallet`'s address, correctly signed by it, but
    // the request claims a different address than the one embedded in it.
    const challenge = await requestChallenge(postNonce, wallet.walletAddress, ip);
    const signature = signChallenge(wallet.privateKey, challenge);

    const res = await postLink(
      new Request("http://x/api/users/wallet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ walletAddress: claimedWallet.walletAddress, challenge, signature }),
      })
    );
    assert.strictEqual(res.status, 401);

    const item = await getUserItem(dynamo, TABLE, session.userId);
    assert.strictEqual(item, undefined);
  } finally {
    await deleteUserItem(dynamo, TABLE, session.userId);
    const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
    const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");
    const windowStart = (name) =>
      Math.floor(Date.now() / 1000 / RATE_LIMITS[name].windowSeconds) * RATE_LIMITS[name].windowSeconds;
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `RATE#${session.userId}`, SK: `walletLinkPerUser#${windowStart("walletLinkPerUser")}` },
      })
    );
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `RATE#${ip}`, SK: `walletLinkPerIp#${windowStart("walletLinkPerIp")}` },
      })
    );
    await session.cleanup();
  }
});
