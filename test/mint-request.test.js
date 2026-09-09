const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { randomUUID } = require("node:crypto");
const { hasAwsCredentials } = require("./helpers/aws-credentials");

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

const DB_PATH = path.join(__dirname, "..", "lib", "db.ts");
const importDb = () => import(pathToFileURL(DB_PATH).href);

const ALL_STATUSES = [
  "PENDING",
  "UPLOADING_PICTURE",
  "UPLOADING_METADATA",
  "AWAITING_SIGNATURE",
  "MINTING",
  "CONFIRMED",
  "SIGNATURE_REJECTED",
  "FAILED",
];

// ---------------------------------------------------------------------------
// Transition table — pure, no AWS needed
// ---------------------------------------------------------------------------

test("transition table covers every status exactly once", async () => {
  const { MINT_TRANSITIONS } = await importDb();
  assert.deepStrictEqual(Object.keys(MINT_TRANSITIONS).sort(), [...ALL_STATUSES].sort());
});

test("CONFIRMED and FAILED are terminal", async () => {
  const { MINT_TRANSITIONS } = await importDb();
  assert.deepStrictEqual(MINT_TRANSITIONS.CONFIRMED, []);
  assert.deepStrictEqual(MINT_TRANSITIONS.FAILED, []);
});

test("nothing transitions back into PENDING", async () => {
  const { MINT_TRANSITIONS } = await importDb();
  for (const [from, tos] of Object.entries(MINT_TRANSITIONS)) {
    assert.ok(!tos.includes("PENDING"), `${from} must not lead back to PENDING`);
  }
});

test("every status names only real statuses", async () => {
  const { MINT_TRANSITIONS } = await importDb();
  for (const [from, tos] of Object.entries(MINT_TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(ALL_STATUSES.includes(to), `${from} -> ${to} is not a real status`);
    }
  }
});

test("the happy path is walkable end to end", async () => {
  const { MINT_TRANSITIONS } = await importDb();
  const happy = [
    "PENDING",
    "UPLOADING_PICTURE",
    "UPLOADING_METADATA",
    "AWAITING_SIGNATURE",
    "MINTING",
    "CONFIRMED",
  ];
  for (let i = 0; i < happy.length - 1; i++) {
    assert.ok(
      MINT_TRANSITIONS[happy[i]].includes(happy[i + 1]),
      `${happy[i]} -> ${happy[i + 1]} must be legal`
    );
  }
});

test("a rejected signature can be retried without re-uploading", async () => {
  const { MINT_TRANSITIONS } = await importDb();
  assert.ok(MINT_TRANSITIONS.SIGNATURE_REJECTED.includes("AWAITING_SIGNATURE"));
});

// The chain is the authority. Reconciliation must be able to record an NFT
// that exists on-chain even when the client told us the user rejected it, or
// died before reporting the submission.
test("CONFIRMED is reachable from every pre-signature-outcome state", async () => {
  const { MINT_TRANSITIONS } = await importDb();
  for (const from of ["AWAITING_SIGNATURE", "MINTING", "SIGNATURE_REJECTED"]) {
    assert.ok(
      MINT_TRANSITIONS[from].includes("CONFIRMED"),
      `reconciliation needs ${from} -> CONFIRMED`
    );
  }
});

test("every non-terminal status can fail", async () => {
  const { MINT_TRANSITIONS } = await importDb();
  for (const [from, tos] of Object.entries(MINT_TRANSITIONS)) {
    if (from === "CONFIRMED" || from === "FAILED") continue;
    assert.ok(tos.includes("FAILED"), `${from} must be able to fail`);
  }
});

// ---------------------------------------------------------------------------
// Live DynamoDB behaviour
// ---------------------------------------------------------------------------

const skip = !hasAwsCredentials() || !process.env.DYNAMODB_TABLE_NAME;
const opts = { skip: skip && "no AWS credentials or DYNAMODB_TABLE_NAME" };

async function cleanup(assetId) {
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { dynamo, TABLE } = await import(
    pathToFileURL(path.join(__dirname, "..", "lib", "dynamo.ts")).href
  );
  await dynamo.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: `MINTREQ#${assetId}`, SK: `MINTREQ#${assetId}` },
    })
  );
}

function baseReq(assetId) {
  return {
    assetId,
    userId: `test-user-${assetId}`,
    ownerWallet: "So11111111111111111111111111111111111111112",
    network: "devnet",
  };
}

test("create then read round-trips, and starts PENDING with a TTL", opts, async () => {
  const { createMintRequest, getMintRequest } = await importDb();
  const assetId = randomUUID();
  try {
    const created = await createMintRequest(baseReq(assetId));
    assert.strictEqual(created.status, "PENDING");
    assert.strictEqual(created.attempts, 0);
    assert.ok(created.mintRequestId);

    const read = await getMintRequest(assetId);
    assert.strictEqual(read.assetId, assetId);
    assert.strictEqual(read.status, "PENDING");
  } finally {
    await cleanup(assetId);
  }
});

// The duplicate-mint guard. This is the single most important test here: it is
// what stops a double-click or a retried fetch producing two NFTs.
test("a second create for the same asset is rejected", opts, async () => {
  const { createMintRequest, MintRequestExistsError } = await importDb();
  const assetId = randomUUID();
  try {
    await createMintRequest(baseReq(assetId));
    await assert.rejects(
      () => createMintRequest(baseReq(assetId)),
      (err) => err instanceof MintRequestExistsError
    );
  } finally {
    await cleanup(assetId);
  }
});

test("concurrent creates: exactly one wins", opts, async () => {
  const { createMintRequest, MintRequestExistsError } = await importDb();
  const assetId = randomUUID();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => createMintRequest(baseReq(assetId)))
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    assert.strictEqual(ok.length, 1, "exactly one create must succeed");
    assert.strictEqual(failed.length, 4);
    for (const f of failed) {
      assert.ok(f.reason instanceof MintRequestExistsError);
    }
  } finally {
    await cleanup(assetId);
  }
});

test("an illegal transition is refused", opts, async () => {
  const { createMintRequest, transitionMintRequest, MintTransitionError } = await importDb();
  const assetId = randomUUID();
  try {
    await createMintRequest(baseReq(assetId));
    // PENDING -> MINTING skips the whole upload + signature sequence.
    await assert.rejects(
      () => transitionMintRequest(assetId, "MINTING"),
      (err) => err instanceof MintTransitionError
    );
  } finally {
    await cleanup(assetId);
  }
});

test("transitioning a row that does not exist is refused", opts, async () => {
  const { transitionMintRequest, MintTransitionError } = await importDb();
  await assert.rejects(
    () => transitionMintRequest(randomUUID(), "UPLOADING_PICTURE"),
    (err) => err instanceof MintTransitionError
  );
});

test("patch fields persist and attempts increment", opts, async () => {
  const { createMintRequest, transitionMintRequest } = await importDb();
  const assetId = randomUUID();
  try {
    await createMintRequest(baseReq(assetId));
    await transitionMintRequest(assetId, "UPLOADING_PICTURE");
    await transitionMintRequest(assetId, "UPLOADING_METADATA", {
      pictureUri: "https://arweave.test/pic",
    });
    const awaiting = await transitionMintRequest(
      assetId,
      "AWAITING_SIGNATURE",
      { metadataUri: "https://arweave.test/meta", assetAddress: "AssetPubkey111" },
      { incrementAttempts: true }
    );
    assert.strictEqual(awaiting.pictureUri, "https://arweave.test/pic");
    assert.strictEqual(awaiting.metadataUri, "https://arweave.test/meta");
    assert.strictEqual(awaiting.assetAddress, "AssetPubkey111");
    assert.strictEqual(awaiting.attempts, 1);
  } finally {
    await cleanup(assetId);
  }
});

test("retry after rejection reuses the stored URIs", opts, async () => {
  const { createMintRequest, transitionMintRequest } = await importDb();
  const assetId = randomUUID();
  try {
    await createMintRequest(baseReq(assetId));
    await transitionMintRequest(assetId, "UPLOADING_PICTURE");
    await transitionMintRequest(assetId, "UPLOADING_METADATA", {
      pictureUri: "https://arweave.test/pic",
    });
    await transitionMintRequest(assetId, "AWAITING_SIGNATURE", {
      metadataUri: "https://arweave.test/meta",
    });
    const rejected = await transitionMintRequest(assetId, "SIGNATURE_REJECTED");
    assert.strictEqual(rejected.status, "SIGNATURE_REJECTED");

    const retried = await transitionMintRequest(
      assetId,
      "AWAITING_SIGNATURE",
      {},
      { incrementAttempts: true }
    );
    assert.strictEqual(retried.status, "AWAITING_SIGNATURE");
    assert.strictEqual(retried.pictureUri, "https://arweave.test/pic");
    assert.strictEqual(retried.metadataUri, "https://arweave.test/meta");
  } finally {
    await cleanup(assetId);
  }
});

// This is what stops the cleanup sweep deleting the record of a real NFT.
test("confirming drops the TTL attribute", opts, async () => {
  const { createMintRequest, transitionMintRequest, confirmMintRequest } = await importDb();
  const { GetCommand } = require("@aws-sdk/lib-dynamodb");
  const { dynamo, TABLE } = await import(
    pathToFileURL(path.join(__dirname, "..", "lib", "dynamo.ts")).href
  );
  const assetId = randomUUID();
  try {
    await createMintRequest(baseReq(assetId));

    const before = await dynamo.send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: `MINTREQ#${assetId}`, SK: `MINTREQ#${assetId}` },
      })
    );
    assert.ok(typeof before.Item.expiresAt === "number", "unconfirmed rows must expire");

    await transitionMintRequest(assetId, "UPLOADING_PICTURE");
    await transitionMintRequest(assetId, "UPLOADING_METADATA");
    await transitionMintRequest(assetId, "AWAITING_SIGNATURE");
    await transitionMintRequest(assetId, "MINTING");
    const confirmed = await confirmMintRequest(assetId, {
      mintAddress: "AssetPubkey111",
      txSignature: "SigSigSig",
    });

    assert.strictEqual(confirmed.status, "CONFIRMED");
    assert.strictEqual(confirmed.mintAddress, "AssetPubkey111");
    assert.strictEqual(confirmed.txSignature, "SigSigSig");
    assert.ok(confirmed.confirmedAt);

    const after = await dynamo.send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: `MINTREQ#${assetId}`, SK: `MINTREQ#${assetId}` },
      })
    );
    assert.strictEqual(after.Item.expiresAt, undefined, "a confirmed NFT must never expire");
  } finally {
    await cleanup(assetId);
  }
});

test("CONFIRMED is terminal in the database, not just the table", opts, async () => {
  const { createMintRequest, transitionMintRequest, confirmMintRequest, MintTransitionError } =
    await importDb();
  const assetId = randomUUID();
  try {
    await createMintRequest(baseReq(assetId));
    await transitionMintRequest(assetId, "UPLOADING_PICTURE");
    await transitionMintRequest(assetId, "UPLOADING_METADATA");
    await transitionMintRequest(assetId, "AWAITING_SIGNATURE");
    await transitionMintRequest(assetId, "MINTING");
    await confirmMintRequest(assetId, { mintAddress: "A", txSignature: "S" });

    // A replayed confirm, or a late rejection, must not move a confirmed row.
    await assert.rejects(
      () => transitionMintRequest(assetId, "FAILED"),
      (err) => err instanceof MintTransitionError
    );
    await assert.rejects(
      () => transitionMintRequest(assetId, "SIGNATURE_REJECTED"),
      (err) => err instanceof MintTransitionError
    );
  } finally {
    await cleanup(assetId);
  }
});

test("concurrent transitions from one state: exactly one wins", opts, async () => {
  const { createMintRequest, transitionMintRequest, MintTransitionError } = await importDb();
  const assetId = randomUUID();
  try {
    await createMintRequest(baseReq(assetId));
    const results = await Promise.allSettled([
      transitionMintRequest(assetId, "UPLOADING_PICTURE"),
      transitionMintRequest(assetId, "UPLOADING_PICTURE"),
      transitionMintRequest(assetId, "UPLOADING_PICTURE"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    assert.strictEqual(ok.length, 1, "a transition must not fire twice");
    for (const f of results.filter((r) => r.status === "rejected")) {
      assert.ok(f.reason instanceof MintTransitionError);
    }
  } finally {
    await cleanup(assetId);
  }
});
