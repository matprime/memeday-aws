const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { hasAwsCredentials } = require("./helpers/aws-credentials");
const { generateTestWallet, signChallenge, decodeJwtSub } = require("./helpers/test-auth");

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
  if (!process.env.DYNAMODB_TABLE_NAME || !hasAwsCredentials()) {
    t.skip("Missing DYNAMODB_TABLE_NAME or AWS credentials");
    return true;
  }
  return false;
}

function skipIfNoCognito(t) {
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

async function deleteUserItem(dynamo, TABLE, userId) {
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `USER#${userId}` } }));
}

// ── finalizeMeme: creatorWalletAddr only snapshots a verified wallet (KAN-75 follow-up) ──
// components/MemeActionBar.tsx and components/MemeCard.tsx both read
// meme.creatorWalletAddr directly as the Solana Pay tip destination
// (TipModal creatorWallet={meme.creatorWalletAddr ?? ""}) with no lookup of
// the creator's current walletVerifiedAt at render time. The gate has to live
// at the snapshot itself, in finalizeMeme, or every render site would need
// its own extra read.

test("finalizeMeme: an unverified walletAddr is not snapshotted onto the meme (unverified row rejected)", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { upsertUser, createPendingUpload, getPendingUpload, finalizeMeme, getMemeById } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { randomUUID } = require("node:crypto");

  const creatorId = `test-unverified-wallet-${Date.now()}`;
  const pendingId = randomUUID();
  // walletVerified: false (the pre-KAN-75 shape this test is about) means
  // upsertUser never stamps walletVerifiedAt — walletAddr ends up set with
  // no verification marker at all, same as an untouched legacy row.
  await upsertUser({ userId: creatorId, walletAddr: "SomeAddressWithNoProof1111111111111111111", walletVerified: false });
  await createPendingUpload({
    id: pendingId,
    creatorId,
    s3Key: `uploads/${creatorId}/${pendingId}.png`,
    caption: "unverified wallet test",
  });
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `PENDING#${pendingId}`, SK: `PENDING#${pendingId}` },
      UpdateExpression: "SET #s = :active",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":active": "active" },
    })
  );

  try {
    const pending = await getPendingUpload(pendingId);
    const meme = await finalizeMeme(pending, { isNFT: false });
    assert.strictEqual(meme.creatorWalletAddr, undefined, "an unverified wallet must never become a tip destination");

    const stored = await getMemeById(meme.id);
    assert.strictEqual(stored.creatorWalletAddr, undefined);
  } finally {
    await deleteUserItem(dynamo, TABLE, creatorId);
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${pendingId}`, SK: `MEME#${pendingId}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PENDING#${pendingId}`, SK: `PENDING#${pendingId}` } }));
  }
});

test("finalizeMeme: a verified walletAddr is snapshotted onto the meme (verified row passes)", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { upsertUser, createPendingUpload, getPendingUpload, finalizeMeme, getMemeById } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
  const { randomUUID } = require("node:crypto");

  const creatorId = `test-verified-wallet-${Date.now()}`;
  const pendingId = randomUUID();
  const walletAddr = "SomeAddressWithProof11111111111111111111";
  await upsertUser({ userId: creatorId, walletAddr, walletVerified: true });
  await createPendingUpload({
    id: pendingId,
    creatorId,
    s3Key: `uploads/${creatorId}/${pendingId}.png`,
    caption: "verified wallet test",
  });
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `PENDING#${pendingId}`, SK: `PENDING#${pendingId}` },
      UpdateExpression: "SET #s = :active",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":active": "active" },
    })
  );

  try {
    const pending = await getPendingUpload(pendingId);
    const meme = await finalizeMeme(pending, { isNFT: false });
    assert.strictEqual(meme.creatorWalletAddr, walletAddr, "a verified wallet is the tip destination, same as before KAN-75");

    const stored = await getMemeById(meme.id);
    assert.strictEqual(stored.creatorWalletAddr, walletAddr);
  } finally {
    await deleteUserItem(dynamo, TABLE, creatorId);
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${pendingId}`, SK: `MEME#${pendingId}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PENDING#${pendingId}`, SK: `PENDING#${pendingId}` } }));
  }
});

// ── read-time gate: getMemeById / getMemes strip an unverified snapshot
// (KAN-75 follow-up). createMeme itself has no gate, so writing
// creatorWalletAddr through it directly simulates a pre-existing row exactly
// like one that predates this change would look — this is what proves the
// gate lives at serve time, independent of the write-time one above.

test("getMemeById: an unverified creator's stored snapshot is not exposed as a tip destination", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { upsertUser, createMeme, getMemeById } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const creatorId = `test-readtime-unverified-${Date.now()}`;
  const walletAddr = "LegacyUnverifiedAddr111111111111111111111";
  await upsertUser({ userId: creatorId, walletAddr, walletVerified: false });
  const meme = await createMeme({
    creatorId,
    creatorWalletAddr: walletAddr,
    s3Key: `test/${creatorId}.png`,
    caption: "read-time gate test",
    isNFT: false,
  });

  try {
    const fetched = await getMemeById(meme.id);
    assert.ok(fetched, "the meme renders normally, it is not broken or hidden by the gate");
    assert.strictEqual(fetched.creatorWalletAddr, undefined, "an unverified creator's snapshot must not reach the tip button");
  } finally {
    await deleteUserItem(dynamo, TABLE, creatorId);
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } }));
  }
});

test("getMemeById: the same meme exposes the tip destination again once walletVerifiedAt is stamped, no MEME# row change", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { upsertUser, createMeme, getMemeById } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

  const creatorId = `test-readtime-selfheal-${Date.now()}`;
  const walletAddr = "SelfHealAddr1111111111111111111111111111";
  await upsertUser({ userId: creatorId, walletAddr, walletVerified: false });
  const meme = await createMeme({
    creatorId,
    creatorWalletAddr: walletAddr,
    s3Key: `test/${creatorId}.png`,
    caption: "self heal test",
    isNFT: false,
  });

  try {
    const before = await getMemeById(meme.id);
    assert.strictEqual(before.creatorWalletAddr, undefined, "starts gated");

    const { Item: memeRowBefore } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } })
    );

    // Re-link touches only the USER# row. No migration, no meme write.
    await upsertUser({ userId: creatorId, walletAddr, walletVerified: true });

    const after = await getMemeById(meme.id);
    assert.strictEqual(after.creatorWalletAddr, walletAddr, "verifying re-opens tipping with no meme migration");

    const { Item: memeRowAfter } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } })
    );
    assert.deepStrictEqual(memeRowAfter, memeRowBefore, "the MEME# row itself is untouched by the re-link");
  } finally {
    await deleteUserItem(dynamo, TABLE, creatorId);
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } }));
  }
});

test("getMemes: an unverified creator's meme appears in the feed with tipping unavailable, not broken", async (t) => {
  if (skipIfNoCredentials(t)) return;
  const { upsertUser, createMeme, getMemes } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

  const creatorId = `test-feed-unverified-${Date.now()}`;
  const walletAddr = "FeedUnverifiedAddr11111111111111111111111";
  await upsertUser({ userId: creatorId, walletAddr, walletVerified: false });
  const meme = await createMeme({
    creatorId,
    creatorWalletAddr: walletAddr,
    s3Key: `test/${creatorId}.png`,
    caption: "feed gate test",
    isNFT: false,
  });
  // New memes always start with score: 0 (lib/db.ts createMeme), so the feed
  // SK matches padScore(0) from lambdas/stream-handler/index.ts — same
  // derivation as test/pending-upload.test.js.
  const feedSK = `${"0".repeat(15)}#${meme.id}`;

  try {
    let feedItem;
    for (let i = 0; i < 10; i++) {
      const { Item } = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
      if (Item) {
        feedItem = Item;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(feedItem, "StreamHandler materialized the feed entry before this assertion runs");

    const feed = await getMemes();
    const found = feed.find((m) => m.id === meme.id);
    assert.ok(found, "the meme renders normally in the feed, it is not broken or hidden by the gate");
    assert.strictEqual(found.creatorWalletAddr, undefined, "the feed path (batched, not per-card) also strips an unverified snapshot");
  } finally {
    await deleteUserItem(dynamo, TABLE, creatorId);
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "FEED#GLOBAL", SK: feedSK } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } }));
  }
});

// ── wallet login stamps walletVerifiedAt (KAN-75 follow-up) ────────────────

test("wallet login: a successful signature check stamps walletVerifiedAt on the USER# row", async (t) => {
  if (skipIfNoCognito(t)) return;
  const { POST: postVerify } = await load("app/api/auth/wallet/verify/route.ts");
  const { POST: postNonce } = await load("app/api/auth/wallet/nonce/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const {
    CognitoIdentityProviderClient,
    AdminDeleteUserCommand,
  } = require("@aws-sdk/client-cognito-identity-provider");

  const wallet = generateTestWallet();
  const ip = `test-login-stamp-ip-${Date.now()}`;
  let userId;
  try {
    const nonceRes = await postNonce(
      new Request("http://x/api/auth/wallet/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ walletAddress: wallet.walletAddress }),
      })
    );
    const { challenge } = await nonceRes.json();
    const signature = signChallenge(wallet.privateKey, challenge);

    const verifyRes = await postVerify(
      new Request("http://x/api/auth/wallet/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ walletAddress: wallet.walletAddress, challenge, signature }),
      })
    );
    assert.strictEqual(verifyRes.status, 200);
    const { accessToken } = await verifyRes.json();
    userId = decodeJwtSub(accessToken);

    const { GetCommand } = require("@aws-sdk/lib-dynamodb");
    const { Item } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `USER#${userId}` } })
    );
    assert.ok(Item, "wallet login writes the USER# row, not just the Cognito identity");
    assert.strictEqual(Item.walletAddr, wallet.walletAddress);
    assert.ok(Item.walletVerifiedAt, "walletVerifiedAt is stamped on a successful wallet login");
  } finally {
    if (userId) await deleteUserItem(dynamo, TABLE, userId);
    const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? "us-east-1" });
    await client
      .send(
        new AdminDeleteUserCommand({
          UserPoolId: process.env.COGNITO_USER_POOL_ID,
          Username: `wallet_${wallet.walletAddress}`,
        })
      )
      .catch(() => {});
  }
});
