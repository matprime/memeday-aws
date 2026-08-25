const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { hasAwsCredentials } = require("./helpers/aws-credentials");

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
    // Route files under app/ use the "@/..." path alias (tsconfig paths),
    // which only bundler-aware tooling resolves — map it to the repo root
    // the same way the relative-import branch below maps ".ts".
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

// ── lib/db.ts: createReport dedupe + first-report detection ────────────────

test("createReport: first report from a new identity is flagged first, a repeat from the same identity is deduped and keeps the original reason", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { createMeme, createReport } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

  const creatorId = `test-report-creator-${Date.now()}`;
  const meme = await createMeme({
    creatorId,
    s3Key: "test/report.png",
    caption: "report test meme",
    isNFT: false,
  });
  const identityHash = "abc123def456";

  try {
    const first = await createReport({
      memeId: meme.id,
      identityHash,
      reason: "original reason",
    });
    assert.strictEqual(first.isFirstReport, true, "first report from a new identity is the first");

    const second = await createReport({
      memeId: meme.id,
      identityHash,
      reason: "a different reason on the repeat",
    });
    assert.strictEqual(second.isFirstReport, false, "a repeat from the same identity is never 'first'");

    const { Item } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `REPORT#${identityHash}` } })
    );
    assert.strictEqual(Item.reason, "original reason", "first write wins: the reason is never updated on a repeat");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `REPORT#${identityHash}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } }));
  }
});

test("createReport: a second report from a different identity on the same meme is not 'first'", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { createMeme, createReport } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const creatorId = `test-report-creator2-${Date.now()}`;
  const meme = await createMeme({
    creatorId,
    s3Key: "test/report2.png",
    caption: "report test meme 2",
    isNFT: false,
  });
  const identityA = `identA${Date.now()}`;
  const identityB = `identB${Date.now()}`;

  try {
    const first = await createReport({ memeId: meme.id, identityHash: identityA, reason: "r1" });
    assert.strictEqual(first.isFirstReport, true);

    const secondReporter = await createReport({ memeId: meme.id, identityHash: identityB, reason: "r2" });
    assert.strictEqual(
      secondReporter.isFirstReport,
      false,
      "notify-on-first-report fires only for the very first reporter, not every distinct one"
    );
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `REPORT#${identityA}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `REPORT#${identityB}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } }));
  }
});

// ── lib/db.ts: getReportedMemeIds (authenticated "hide from own feed") ─────

test("getReportedMemeIds: returns only the memes this identity has reported", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { createMeme, createReport, getReportedMemeIds } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const creatorId = `test-reported-ids-${Date.now()}`;
  const [memeA, memeB] = await Promise.all([
    createMeme({ creatorId, s3Key: "a.png", caption: "a", isNFT: false }),
    createMeme({ creatorId, s3Key: "b.png", caption: "b", isNFT: false }),
  ]);
  const identityHash = `reporter${Date.now()}`;

  try {
    await createReport({ memeId: memeA.id, identityHash, reason: "spam" });

    const reported = await getReportedMemeIds(identityHash, [memeA.id, memeB.id]);
    assert.deepStrictEqual(reported, [memeA.id], "only the reported meme comes back, the untouched one does not");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeA.id}`, SK: `REPORT#${identityHash}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeA.id}`, SK: `MEME#${memeA.id}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${memeB.id}`, SK: `MEME#${memeB.id}` } }));
  }
});

// ── lib/db.ts: takedownMeme + getMemeById reusing KAN-13 not-found handling ─

test("takedownMeme: sets status removed, and the meme is then unreachable via getMemeById (KAN-13 reuse)", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { createMeme, takedownMeme, getMemeById } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

  const creatorId = `test-takedown-${Date.now()}`;
  const meme = await createMeme({
    creatorId,
    s3Key: "test/takedown.png",
    caption: "takedown test",
    isNFT: false,
  });

  try {
    const before = await getMemeById(meme.id);
    assert.ok(before, "meme is visible before takedown");

    const removed = await takedownMeme(meme.id, "test-operator-sub");
    assert.strictEqual(removed, true);

    const after = await getMemeById(meme.id);
    assert.strictEqual(after, null, "a removed meme returns 404-equivalent (null) same as pending_review");

    const { Item } = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } })
    );
    assert.strictEqual(Item.status, "removed");
    assert.strictEqual(Item.removedBy, "test-operator-sub", "operator identity is recorded for the takedown Lambda's SNS body");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } }));
  }
});

test("takedownMeme: a nonexistent memeId returns false rather than creating a phantom item", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { takedownMeme } = await load("lib/db.ts");
  const result = await takedownMeme(`does-not-exist-${Date.now()}`, "test-operator-sub");
  assert.strictEqual(result, false);
});

// ── lib/db.ts: getOpenReports (admin listing) ───────────────────────────────
// Reads REPORTQUEUE#GLOBAL directly via Query (dynamodb:Query is already
// granted to the runtime user, no Scan needed). Populating that queue is
// StreamHandler's job, covered separately in test/stream-handler.test.js —
// here the queue items are seeded directly so this test is a pure read-path
// check, not a re-test of the Streams pipeline.

test("getOpenReports: reads REPORTQUEUE#GLOBAL directly, excludes nothing it wasn't told to, and sorts by lastReportedAt", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { getOpenReports } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { PutCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const memeIdOlder = `test-queue-older-${Date.now()}`;
  const memeIdNewer = `test-queue-newer-${Date.now()}`;
  const creatorId = `test-queue-creator-${Date.now()}`;

  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: "REPORTQUEUE#GLOBAL",
        SK: `MEME#${memeIdOlder}`,
        memeId: memeIdOlder,
        creatorId,
        s3Key: "older.png",
        reason: "first reason",
        firstReportedAt: "2024-01-01T00:00:00.000Z",
        lastReportedAt: "2024-01-02T00:00:00.000Z",
        reporterHashes: new Set(["hasha", "hashb"]),
      },
    })
  );
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: "REPORTQUEUE#GLOBAL",
        SK: `MEME#${memeIdNewer}`,
        memeId: memeIdNewer,
        creatorId,
        s3Key: "newer.png",
        reason: "another reason",
        firstReportedAt: "2024-02-01T00:00:00.000Z",
        lastReportedAt: "2024-02-02T00:00:00.000Z",
        reporterHashes: new Set(["hashc"]),
      },
    })
  );

  try {
    const openReports = await getOpenReports();
    const older = openReports.find((r) => r.memeId === memeIdOlder);
    const newer = openReports.find((r) => r.memeId === memeIdNewer);

    assert.ok(older, "queue item appears in the listing");
    assert.strictEqual(older.reason, "first reason");
    assert.strictEqual(older.reporterCount, 2, "reporterCount comes from the reporterHashes set size");
    assert.ok(older.imageUrl.includes("older.png"), "imageUrl is derived from s3Key");

    assert.ok(newer);
    assert.strictEqual(newer.reporterCount, 1);

    assert.ok(
      openReports.indexOf(newer) < openReports.indexOf(older),
      "sorted by lastReportedAt descending, most recently reported first"
    );
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeIdOlder}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${memeIdNewer}` } }));
  }
});

// ── lib/rate-limit-config.ts: report limits exist and behave like every other limit ─

test("rate limiting: reportPerIp blocks over the limit, reportPerUser is a separate counter", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { isRateLimited } = await load("lib/rate-limit.ts");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const windowStart = (limitName) => {
    const { windowSeconds } = RATE_LIMITS[limitName];
    return Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  };
  const keyFor = (limitName, identity) => ({
    PK: `RATE#${identity}`,
    SK: `${RATE_LIMITS[limitName].key}#${windowStart(limitName)}`,
  });

  const ip = `test-report-ip-${Date.now()}`;
  const userId = `test-report-user-${Date.now()}`;

  try {
    // Seed the IP counter straight to its max, same shortcut as rate-limit.test.js.
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: keyFor("reportPerIp", ip),
        UpdateExpression: "ADD requestCount :n",
        ExpressionAttributeValues: { ":n": RATE_LIMITS.reportPerIp.max },
      })
    );

    assert.strictEqual(await isRateLimited("reportPerIp", ip), true, "over the per-IP ceiling blocks");
    assert.strictEqual(
      await isRateLimited("reportPerUser", userId),
      false,
      "a separate identity/limit is unaffected — per-user and per-IP are independent counters"
    );
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: keyFor("reportPerIp", ip) }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: keyFor("reportPerUser", userId) }));
  }
});

test("rate limiting: a counter failure on a report limit still fails open", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { isRateLimited } = await load("lib/rate-limit.ts");
  const { dynamo } = await load("lib/dynamo.ts");

  const originalSend = dynamo.send.bind(dynamo);
  const originalConsoleError = console.error;
  console.error = () => {};
  dynamo.send = async () => {
    throw new Error("simulated DynamoDB outage");
  };

  try {
    const blocked = await isRateLimited("reportPerUser", `test-report-failopen-${Date.now()}`);
    assert.strictEqual(blocked, false, "a broken counter must result in the report being accepted, not a 429");
  } finally {
    dynamo.send = originalSend;
    console.error = originalConsoleError;
  }
});

// ── lib/sns.ts: publishAlert never throws, even when the underlying call fails ─

test("publishAlert: a publish failure is caught and logged, never rethrown", async () => {
  const { sns, publishAlert } = await load("lib/sns.ts");
  process.env.SNS_ALERTS_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:test-topic";

  const originalSend = sns.send;
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  sns.send = async () => {
    throw new Error("simulated SNS outage");
  };

  try {
    await assert.doesNotReject(
      publishAlert("MemeDay report: test", "body"),
      "publishAlert must never throw even when the underlying SNS call fails"
    );
    assert.ok(errors.length > 0, "the failure is logged");
  } finally {
    sns.send = originalSend;
    console.error = originalConsoleError;
  }
});

test("publishAlert: a successful publish sends the given subject and message to the alerts topic", async () => {
  const { sns, publishAlert } = await load("lib/sns.ts");
  process.env.SNS_ALERTS_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:test-topic";

  const originalSend = sns.send;
  let published;
  sns.send = async (command) => {
    published = command.input;
    return {};
  };

  try {
    await publishAlert("MemeDay report: abc123", "memeId: abc123");
    assert.strictEqual(published.TopicArn, "arn:aws:sns:us-east-1:000000000000:test-topic");
    assert.strictEqual(published.Subject, "MemeDay report: abc123");
    assert.strictEqual(published.Message, "memeId: abc123");
  } finally {
    sns.send = originalSend;
  }
});

// ── app/api/memes/[id]/report/route.ts: full route behavior, anonymous caller ─

test("report route: unauthenticated report succeeds, publishes to SNS once, and a duplicate is indistinguishable", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { createMeme, getMemeById } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { sns } = await load("lib/sns.ts");
  const { POST } = await load("app/api/memes/[id]/report/route.ts");
  process.env.SNS_ALERTS_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:test-topic";

  const creatorId = `test-report-route-${Date.now()}`;
  const meme = await createMeme({
    creatorId,
    s3Key: "test/report-route.png",
    caption: "report route test",
    isNFT: false,
  });
  const ip = `10.0.0.${Date.now() % 256}`;

  const publishCalls = [];
  const originalSend = sns.send;
  sns.send = async (command) => {
    publishCalls.push(command.input);
    return {};
  };

  function reportRequest(reason) {
    return new Request(`http://x/api/memes/${meme.id}/report`, {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  }

  try {
    const first = await POST(reportRequest("this is spam"), { params: Promise.resolve({ id: meme.id }) });
    assert.strictEqual(first.status, 200);
    const firstBody = await first.json();
    assert.strictEqual(firstBody.success, true);
    assert.strictEqual(publishCalls.length, 1, "first report publishes exactly once");
    assert.match(publishCalls[0].Subject, new RegExp(`MemeDay report: ${meme.id}`));

    const second = await POST(reportRequest("trying a different reason"), {
      params: Promise.resolve({ id: meme.id }),
    });
    assert.strictEqual(second.status, 200, "a duplicate report returns the same success response");
    const secondBody = await second.json();
    assert.deepStrictEqual(secondBody, firstBody, "response is indistinguishable from the first report");
    assert.strictEqual(publishCalls.length, 1, "a second report on the same meme does not publish again");

    const memeAfter = await getMemeById(meme.id);
    assert.strictEqual(memeAfter.status, "active", "reporting never changes the meme's own status");
  } finally {
    sns.send = originalSend;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `REPORT#${require("crypto").createHash("sha256").update(process.env.WALLET_AUTH_SECRET).update(ip).digest("hex").slice(0, 12)}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } }));
    const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");
    const windowStart = Math.floor(Date.now() / 1000 / RATE_LIMITS.reportPerIp.windowSeconds) * RATE_LIMITS.reportPerIp.windowSeconds;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `RATE#${ip}`, SK: `reportPerIp#${windowStart}` } }));
  }
});

test("report route: exceeding the per-IP limit returns 429 without writing a report", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { createMeme, getReportedMemeIds } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");
  const { POST } = await load("app/api/memes/[id]/report/route.ts");

  const creatorId = `test-report-429-${Date.now()}`;
  const meme = await createMeme({
    creatorId,
    s3Key: "test/report-429.png",
    caption: "report 429 test",
    isNFT: false,
  });
  const ip = `10.0.1.${Date.now() % 256}`;
  const windowStart = Math.floor(Date.now() / 1000 / RATE_LIMITS.reportPerIp.windowSeconds) * RATE_LIMITS.reportPerIp.windowSeconds;
  const rateKey = { PK: `RATE#${ip}`, SK: `reportPerIp#${windowStart}` };

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: rateKey,
        UpdateExpression: "ADD requestCount :n",
        ExpressionAttributeValues: { ":n": RATE_LIMITS.reportPerIp.max },
      })
    );

    const res = await POST(
      new Request(`http://x/api/memes/${meme.id}/report`, {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/json" },
        body: JSON.stringify({ reason: "should be blocked" }),
      }),
      { params: Promise.resolve({ id: meme.id }) }
    );
    assert.strictEqual(res.status, 429);

    const identityHash = require("crypto")
      .createHash("sha256")
      .update(process.env.WALLET_AUTH_SECRET)
      .update(ip)
      .digest("hex")
      .slice(0, 12);
    const reported = await getReportedMemeIds(identityHash, [meme.id]);
    assert.deepStrictEqual(reported, [], "a rate-limited request must not write a report item");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: rateKey }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } }));
  }
});

test("report route: reporting a nonexistent meme returns 404", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { POST } = await load("app/api/memes/[id]/report/route.ts");
  const memeId = `does-not-exist-${Date.now()}`;
  const ip = `10.0.2.${Date.now() % 256}`;

  const res = await POST(
    new Request(`http://x/api/memes/${memeId}/report`, {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ reason: "spam" }),
    }),
    { params: Promise.resolve({ id: memeId }) }
  );
  assert.strictEqual(res.status, 404);
});

// ── admin routes: signed-out caller gets 404, not 403 ───────────────────────

test("admin routes: a signed-out caller gets 404 from the reports listing, the takedown route, and the dismiss route", async () => {
  const { GET } = await load("app/api/admin/reports/route.ts");
  const { POST: takedown } = await load("app/api/admin/memes/[id]/takedown/route.ts");
  const { POST: dismiss } = await load("app/api/admin/memes/[id]/dismiss/route.ts");

  const listRes = await GET(new Request("http://x/api/admin/reports"));
  assert.strictEqual(listRes.status, 404);

  const takedownRes = await takedown(
    new Request("http://x/api/admin/memes/some-id/takedown", { method: "POST" }),
    { params: Promise.resolve({ id: "some-id" }) }
  );
  assert.strictEqual(takedownRes.status, 404);

  const dismissRes = await dismiss(
    new Request("http://x/api/admin/memes/some-id/dismiss", { method: "POST" }),
    { params: Promise.resolve({ id: "some-id" }) }
  );
  assert.strictEqual(dismissRes.status, 404);
});

// ── dismissReport (KAN-43 follow-up: dismiss action) ────────────────────────

test("dismissReport: removes only the queue item — the meme, its status, and the report items are untouched", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { createMeme, createReport, dismissReport, getMemeById } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { PutCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const creatorId = `test-dismiss-${Date.now()}`;
  const meme = await createMeme({ creatorId, s3Key: "dismiss.png", caption: "dismiss test", isNFT: false });
  const identityHash = `dismiss-reporter-${Date.now()}`;
  const queueKey = { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${meme.id}` };

  await createReport({ memeId: meme.id, identityHash, reason: "spam" });
  await dynamo.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: "REPORTQUEUE#GLOBAL",
        SK: `MEME#${meme.id}`,
        memeId: meme.id,
        creatorId,
        s3Key: "dismiss.png",
        reason: "spam",
        firstReportedAt: new Date().toISOString(),
        lastReportedAt: new Date().toISOString(),
        reporterHashes: new Set([identityHash]),
      },
    })
  );

  try {
    await dismissReport(meme.id);

    const queueAfter = await dynamo.send(new GetCommand({ TableName: TABLE, Key: queueKey }));
    assert.strictEqual(queueAfter.Item, undefined, "queue item is gone");

    const memeAfter = await getMemeById(meme.id);
    assert.ok(memeAfter, "the meme itself still exists");
    assert.strictEqual(memeAfter.status, "active", "dismiss never touches the meme's status");

    const reportAfter = await dynamo.send(
      new GetCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `REPORT#${identityHash}` } })
    );
    assert.ok(reportAfter.Item, "the report item is kept as the audit trail");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `REPORT#${identityHash}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: queueKey }));
  }
});

test("dismissReport: never publishes to SNS", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { dismissReport } = await load("lib/db.ts");
  const { sns } = await load("lib/sns.ts");

  const memeId = `test-dismiss-nosns-${Date.now()}`;
  const originalSend = sns.send;
  let called = false;
  sns.send = async () => {
    called = true;
    return {};
  };

  try {
    await dismissReport(memeId);
    assert.strictEqual(called, false, "dismiss is a no-op on content — it must never notify");
  } finally {
    sns.send = originalSend;
  }
});

test("re-report after dismissal: a fresh report recreates the queue item (no suppression by design)", async (t) => {
  if (skipIfNoCredentials(t)) return;

  const { createMeme, dismissReport } = await load("lib/db.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const { handler } = await load("lambdas/stream-handler/index.ts");

  const creatorId = `test-rereport-${Date.now()}`;
  const meme = await createMeme({ creatorId, s3Key: "rereport.png", caption: "rereport test", isNFT: false });
  const queueKey = { PK: "REPORTQUEUE#GLOBAL", SK: `MEME#${meme.id}` };

  try {
    // Dismissed once already (no queue item present — same end state whether
    // it was ever created or already deleted).
    await dismissReport(meme.id);
    const afterDismiss = await dynamo.send(new GetCommand({ TableName: TABLE, Key: queueKey }));
    assert.strictEqual(afterDismiss.Item, undefined);

    // A new report comes in — StreamHandler reacts to the insert with no
    // memory of the earlier dismissal.
    const record = {
      eventName: "INSERT",
      dynamodb: {
        Keys: { PK: { S: `MEME#${meme.id}` }, SK: { S: "REPORT#rereport-hash" } },
        NewImage: {
          PK: { S: `MEME#${meme.id}` },
          SK: { S: "REPORT#rereport-hash" },
          reason: { S: "reported again" },
          createdAt: { S: new Date().toISOString() },
        },
      },
    };
    await handler({ Records: [record] }, {}, () => {});

    const afterReReport = await dynamo.send(new GetCommand({ TableName: TABLE, Key: queueKey }));
    assert.ok(afterReReport.Item, "the queue item reappears — dismiss has no lasting suppression effect");
    assert.strictEqual(afterReReport.Item.reason, "reported again");
  } finally {
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: `MEME#${meme.id}` } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `MEME#${meme.id}`, SK: "REPORT#rereport-hash" } }));
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: queueKey }));
  }
});
