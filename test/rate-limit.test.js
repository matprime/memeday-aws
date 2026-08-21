const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { hasAwsCredentials } = require("./helpers/aws-credentials");

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

// Same extensionless-import hook as voting-enforcement.test.js. next/cache isn't
// used by lib/rate-limit.ts, but lib/rate-limit-config.ts is a plain relative
// import off it, so the resolver hook still needs to find it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    // Node's resolver wants the explicit .js extension; "next/server" (no
    // extension) is only resolvable via bundler-aware tooling like webpack.
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
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

// ── getClientIp: pure function, no DynamoDB needed ──────────────────────────

test("getClientIp: takes the first entry of x-forwarded-for", async () => {
  const { getClientIp } = await load("lib/rate-limit.ts");
  const req = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
  assert.strictEqual(getClientIp(req), "1.2.3.4");
});

test("getClientIp: falls back to \"unknown\" when the header is missing", async () => {
  const { getClientIp } = await load("lib/rate-limit.ts");
  assert.strictEqual(getClientIp(new Request("http://x")), "unknown");
});

test("getClientIp: a multi-entry header logs a warning but does not change the result", async () => {
  const { getClientIp } = await load("lib/rate-limit.ts");
  const warnings = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    const req = new Request("http://x", {
      headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8, 7.7.7.7" },
    });
    assert.strictEqual(getClientIp(req), "9.9.9.9", "still takes the first entry");

    // The warning is throttled to once per process, and an earlier test in
    // this file may already have consumed it, so assert on content only if it
    // fired here.
    const logged = warnings.flat().map((v) => JSON.stringify(v)).join(" ");
    if (logged) {
      assert.doesNotMatch(logged, /9\.9\.9\.9|8\.8\.8\.8/, "IPs are personal data, log the count only");
      assert.ok(logged.includes("3"), "entry count should be logged");
    }
  } finally {
    console.warn = originalConsoleWarn;
  }
});

// ── rateLimitResponse: identical body everywhere ────────────────────────────

test("rateLimitResponse: identical generic body regardless of caller", async () => {
  const { rateLimitResponse } = await load("lib/rate-limit.ts");

  const fromAuthRoute = rateLimitResponse();
  const fromContentRoute = rateLimitResponse();

  assert.strictEqual(fromAuthRoute.status, 429);
  assert.strictEqual(fromContentRoute.status, 429);

  const [authBody, contentBody] = await Promise.all([fromAuthRoute.json(), fromContentRoute.json()]);
  assert.deepStrictEqual(authBody, contentBody);
  // Must not name a limit, threshold, window, or route.
  assert.doesNotMatch(authBody.error, /vote|comment|upload|login|signup|rpc|wallet|day|minute|hour/i);
});

// ── isRateLimited: hits real DynamoDB (MemeDayDev) ──────────────────────────

test("rate limiting behavior", async (t) => {
  if (!process.env.DYNAMODB_TABLE_NAME || !hasAwsCredentials()) {
    t.skip("Missing DYNAMODB_TABLE_NAME or AWS credentials");
    return;
  }

  const { isRateLimited, cloudwatch } = await load("lib/rate-limit.ts");
  const { RATE_LIMITS } = await load("lib/rate-limit-config.ts");
  const { dynamo, TABLE } = await load("lib/dynamo.ts");
  const { UpdateCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

  const windowStart = (limitName) => {
    const { windowSeconds } = RATE_LIMITS[limitName];
    return Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  };
  const keyFor = (limitName, identity) => ({
    PK: `RATE#${identity}`,
    SK: `${RATE_LIMITS[limitName].key}#${windowStart(limitName)}`,
  });

  await t.test("under the limit passes, at the limit passes, over the limit is blocked", async () => {
    // forgotPasswordPerIp has the smallest max (3), so 4 calls is enough to
    // cross it without a slow loop.
    const identity = `test-rl-under-over-${Date.now()}`;
    try {
      assert.strictEqual(await isRateLimited("forgotPasswordPerIp", identity), false, "1st call: under limit");
      assert.strictEqual(await isRateLimited("forgotPasswordPerIp", identity), false, "2nd call: under limit");
      assert.strictEqual(await isRateLimited("forgotPasswordPerIp", identity), false, "3rd call: at the limit, still allowed");
      assert.strictEqual(await isRateLimited("forgotPasswordPerIp", identity), true, "4th call: over the limit, blocked");
    } finally {
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: keyFor("forgotPasswordPerIp", identity) }));
    }
  });

  await t.test("window rollover resets the count", async () => {
    const identity = `test-rl-rollover-${Date.now()}`;
    const limit = RATE_LIMITS.forgotPasswordPerIp;
    const prevWindowStart = windowStart("forgotPasswordPerIp") - limit.windowSeconds;
    const prevKey = { PK: `RATE#${identity}`, SK: `${limit.key}#${prevWindowStart}` };

    // Seed a *previous* window already fully consumed. If the real windowing
    // math didn't roll over on each request, this would still show as blocked.
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: prevKey,
        UpdateExpression: "ADD requestCount :n",
        ExpressionAttributeValues: { ":n": limit.max },
      })
    );

    try {
      const blocked = await isRateLimited("forgotPasswordPerIp", identity);
      assert.strictEqual(blocked, false, "a maxed-out previous window must not carry over into the current one");
    } finally {
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: prevKey }));
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: keyFor("forgotPasswordPerIp", identity) }));
    }
  });

  await t.test("the written item carries a TTL attribute with a future timestamp", async () => {
    const identity = `test-rl-ttl-${Date.now()}`;
    const key = keyFor("confirmPerIp", identity);
    try {
      await isRateLimited("confirmPerIp", identity);
      const { Item } = await dynamo.send(new GetCommand({ TableName: TABLE, Key: key }));
      assert.ok(Item, "expected a written rate-limit item");
      assert.ok(typeof Item.expiresAt === "number", "expected a numeric expiresAt TTL attribute");
      assert.ok(Item.expiresAt > Math.floor(Date.now() / 1000), "expiresAt must be in the future");
    } finally {
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: key }));
    }
  });

  await t.test("a thrown DynamoDB error results in the request being allowed (fail-open)", async () => {
    const originalSend = dynamo.send.bind(dynamo);
    // Stubbed so the fail-open path doesn't publish real datapoints into the
    // dev namespace every time this test runs.
    const originalCwSend = cloudwatch.send.bind(cloudwatch);
    const loggedArgs = [];
    const originalConsoleError = console.error;
    console.error = (...args) => loggedArgs.push(args);
    dynamo.send = async () => {
      throw new Error("simulated DynamoDB outage");
    };
    cloudwatch.send = async () => {};

    const identity = "test-rl-failopen-raw-identity-marker";
    try {
      const blocked = await isRateLimited("loginPerIp", identity);
      assert.strictEqual(blocked, false, "a counter write failure must never produce a 429");

      const logged = loggedArgs.flat().map((v) => JSON.stringify(v)).join(" ");
      assert.ok(logged.includes("loginPerIp"), "log should still name the limit");
      assert.doesNotMatch(logged, /test-rl-failopen-raw-identity-marker/, "raw identity must never be logged");
      assert.match(logged, /"identity":"[0-9a-f]{12}"/, "logged identity should be a 12-hex-char salted hash");
    } finally {
      dynamo.send = originalSend;
      cloudwatch.send = originalCwSend;
      console.error = originalConsoleError;
    }
  });

  await t.test("a failed metric publish does not change fail-open behavior", async () => {
    const originalDynamoSend = dynamo.send.bind(dynamo);
    const originalCwSend = cloudwatch.send.bind(cloudwatch);
    const originalConsoleError = console.error;
    console.error = () => {};

    dynamo.send = async () => {
      throw new Error("simulated DynamoDB outage");
    };
    // The observability path is allowed to be broken too. If a broken metric
    // could turn a fail-open into a 429, fail-open would be a lie.
    cloudwatch.send = async () => {
      throw new Error("simulated CloudWatch outage");
    };

    try {
      const blocked = await isRateLimited("loginPerIp", `test-rl-metric-fail-${Date.now()}`);
      assert.strictEqual(blocked, false, "a failed metric publish must not produce a 429");
    } finally {
      dynamo.send = originalDynamoSend;
      cloudwatch.send = originalCwSend;
      console.error = originalConsoleError;
    }
  });

  await t.test("two-layer route: an exceeded per-IP ceiling blocks even when the per-user count is under its limit", async () => {
    // Mirrors app/api/upload-url and app/api/comments: userLimited || ipLimited.
    const ip = `1.2.3.${Date.now() % 256}`;
    const userId = `test-rl-user-${Date.now()}`;
    const ipMax = RATE_LIMITS.uploadPerIp.max;

    // Seed the IP counter straight to its max in one write instead of looping
    // `max` real calls.
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: keyFor("uploadPerIp", ip),
        UpdateExpression: "ADD requestCount :n",
        ExpressionAttributeValues: { ":n": ipMax },
      })
    );

    try {
      const [userLimited, ipLimited] = await Promise.all([
        isRateLimited("uploadPerUser", userId),
        isRateLimited("uploadPerIp", ip),
      ]);
      assert.strictEqual(userLimited, false, "per-user count should be nowhere near its limit");
      assert.strictEqual(ipLimited, true, "per-IP Sybil ceiling should now be exceeded");
      assert.strictEqual(userLimited || ipLimited, true, "the route must still block the request");
    } finally {
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: keyFor("uploadPerIp", ip) }));
      await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: keyFor("uploadPerUser", userId) }));
    }
  });
});
