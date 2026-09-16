const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { randomUUID } = require("node:crypto");
const { hasAwsCredentials } = require("./helpers/aws-credentials");
const { createTestCognitoSession } = require("./helpers/test-auth");

// Same .env loading as the other integration tests (see bags-token-binding.test.js).
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

async function seedMeme(dynamo, TABLE, memeId, creatorId, extra = {}) {
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
        caption: "Listing test meme",
        status: "active",
        createdAt: new Date().toISOString(),
        ...extra,
      },
    })
  );
}

function listingRequest(memeId, accessToken, body) {
  return new Request(`http://localhost/api/memes/${memeId}/listing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const params = (id) => ({ params: Promise.resolve({ id }) });

// Minting from the meme's own page used to leave an NFT with no price, so
// neither the detail badge nor MemeCard's Buy button appeared (KAN-11).
test("meme listing: the creator prices their minted meme and it becomes listed", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { POST } = await load("app/api/memes/[id]/listing/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  const { accessToken, userId, cleanup } = await createTestCognitoSession(`TestListing${Date.now()}`);
  const memeId = randomUUID();

  try {
    await seedMeme(dynamo, TABLE, memeId, userId, { nftMint: "MintAddr1111111111111111111111111111111111" });

    const res = await POST(listingRequest(memeId, accessToken, { listingPrice: 0.25 }), params(memeId));
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).listingPrice, 0.25);

    const { Item } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } })
    );
    assert.strictEqual(Item.listingPrice, 0.25);
    // MemeCard's Buy button reads status, not just the price.
    assert.strictEqual(Item.status, "listed");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } }));
    const windowStart =
      Math.floor(Date.now() / 1000 / RATE_LIMITS.listingPerUser.windowSeconds) * RATE_LIMITS.listingPerUser.windowSeconds;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `RATE#${userId}`, SK: `listingPerUser#${windowStart}` } }));
    await cleanup();
  }
});

test("meme listing: an un-minted meme, someone else's meme, and a junk price are all refused", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { POST } = await load("app/api/memes/[id]/listing/route.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");

  const { accessToken, userId, cleanup } = await createTestCognitoSession(`TestListingBad${Date.now()}`);
  const unminted = randomUUID();
  const theirs = randomUUID();

  try {
    await seedMeme(dynamo, TABLE, unminted, userId);
    await seedMeme(dynamo, TABLE, theirs, `someone-else-${Date.now()}`, {
      nftMint: "MintAddr2222222222222222222222222222222222",
    });

    // A price on a meme with no NFT has nothing to price.
    const noMint = await POST(listingRequest(unminted, accessToken, { listingPrice: 1 }), params(unminted));
    assert.strictEqual(noMint.status, 409);

    const notMine = await POST(listingRequest(theirs, accessToken, { listingPrice: 1 }), params(theirs));
    assert.strictEqual(notMine.status, 403);

    for (const listingPrice of [0, -1, "1", null, Infinity, 2_000_000]) {
      const bad = await POST(listingRequest(unminted, accessToken, { listingPrice }), params(unminted));
      assert.strictEqual(bad.status, 400, `price ${String(listingPrice)} must be refused`);
    }

    const anon = await POST(listingRequest(unminted, null, { listingPrice: 1 }), params(unminted));
    assert.strictEqual(anon.status, 401);

    // Nothing above may have written a price anywhere.
    const { Item } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${theirs}`, SK: `MEME#${theirs}` } })
    );
    assert.strictEqual(Item.listingPrice, undefined);
    assert.strictEqual(Item.status, "active");
  } finally {
    for (const memeId of [unminted, theirs]) {
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeId}`, SK: `MEME#${memeId}` } }));
    }
    const windowStart =
      Math.floor(Date.now() / 1000 / RATE_LIMITS.listingPerUser.windowSeconds) * RATE_LIMITS.listingPerUser.windowSeconds;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `RATE#${userId}`, SK: `listingPerUser#${windowStart}` } }));
    await cleanup();
  }
});
