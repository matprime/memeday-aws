import { createHash } from "crypto";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { dynamo, TABLE } from "./dynamo";
import { RATE_LIMITS, type RateLimitName } from "./rate-limit-config";

// FIXED WINDOW on purpose, not sliding or token-bucket. windowStart floors to
// a windowSeconds boundary, so a new window is a brand new SK starting at
// zero. That lets a caller burst up to ~2x right at a window boundary — a
// deliberate tradeoff. This guards a cost budget, not a billing meter, so
// that occasional 2x is cheaper to accept than the complexity of a sliding
// window.
const TTL_BUFFER_SECONDS = 60;

// Nothing else in this codebase publishes custom metrics yet, so MemeDay is
// the namespace we are establishing. Keep any future metric under it.
const METRIC_NAMESPACE = "MemeDay";

// Which stack this instance actually writes to is the only honest definition
// of stage here. VERCEL_ENV describes the deployment, not the data: a preview
// deploy can point at either table, and locally it is undefined. The table
// name is already required by lib/dynamo.ts, so this adds no new config.
const STAGE = TABLE === "MemeDayProd" ? "prod" : "dev";

// Exported only so tests can stub .send, the same way they stub dynamo.send.
// Without that, the fail-open tests would publish real datapoints into the dev
// namespace on every run and could eventually trip the dev alarm. Nothing in
// app code should import this.
export const cloudwatch = new CloudWatchClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

// Fire and forget by design: fail-open means a broken counter must not break
// the site, and that has to stay true of the telemetry about the breakage too.
// waitUntil keeps the serverless function alive until the PutMetricData call
// finishes, because otherwise Vercel can freeze the instance the moment the
// response is sent and the metric would be silently dropped. The try/catch is
// not decoration: waitUntil needs a request context, and there is none in
// tests, so we fall back to a plain floating promise there.
function emitCounterFailureMetric(): void {
  const send = cloudwatch
    .send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: "RateLimitCounterFailure",
            Value: 1,
            Unit: "Count",
            // Stage only. No identity dimension, hashed or otherwise:
            // CloudWatch bills per unique dimension combination, so a per-IP
            // dimension would be unbounded in both cardinality and cost.
            Dimensions: [{ Name: "Stage", Value: STAGE }],
          },
        ],
      })
    )
    .catch((err) => {
      console.error("failed to publish RateLimitCounterFailure metric", err);
    });

  try {
    waitUntil(send);
  } catch {
    // No request context (tests, scripts). The promise still runs and already
    // has its own catch, so there is nothing to handle here.
  }
}

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} not set`);
  return v;
}

// Reuses WALLET_AUTH_SECRET as the salt instead of adding a second secret
// just for this. Raw IPs and Cognito subs are personal data under GDPR (we
// run from the EU on eu-west-1), so logs only ever get a salted hash. An
// unsalted hash of an IPv4 address is reversible by brute force since the
// whole address space is enumerable — the salt is what stops that.
export function hashIdentity(identity: string): string {
  return createHash("sha256")
    .update(getEnv("WALLET_AUTH_SECRET"))
    .update(identity)
    .digest("hex")
    .slice(0, 12);
}

// Logged at most once per process instance. Under a misconfiguration this
// condition would be true on every single request, and an unthrottled warning
// would flood the logs.
let loggedMultiEntryForwardedFor = false;

// x-forwarded-for is set by Vercel's own edge network from the real TCP
// connection, and Vercel is the only way to reach this deployment — there is
// no path that lets a client hand its own value straight to the function. No
// Next.js route here sets `runtime = "edge"`, so this is a Node.js function,
// where `request.ip` was removed and geo/ip helpers aren't available either;
// the header is the correct and only source for this app.
//
// That is exactly why the multi-entry check below exists. Today the header
// should hold exactly one IP. More than one entry means a proxy or CDN has
// been put in front of Vercel, which invalidates the assumption every per-IP
// limit rests on: the first entry would then be client-supplied and trivially
// spoofable. Do not delete this as dead code. It is a canary for an upstream
// change, not a guard against a bug in this file.
export function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");

  if (forwardedFor && forwardedFor.includes(",") && !loggedMultiEntryForwardedFor) {
    loggedMultiEntryForwardedFor = true;
    // Count only. The header value is IP addresses, which are personal data.
    console.warn("x-forwarded-for has multiple entries, per-IP limits may be spoofable", {
      entryCount: forwardedFor.split(",").length,
    });
  }

  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}

// Same body on every route, always. Naming the limit, threshold, window or
// route would hand an attacker a tuning oracle; a different shape on an auth
// route vs. a content route would leak whether an account exists.
export function rateLimitResponse(): NextResponse {
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again." },
    { status: 429 }
  );
}

// One helper, used by every rate-limited route. Does a single atomic
// DynamoDB ADD against a fixed window and reports whether `identity` is over
// `name`'s limit.
//
// FAIL-OPEN: if the counter write itself throws, that's an infra fault, not
// an enforcement event — log it (hashed identity only) and treat the caller
// as not limited. A DynamoDB hiccup should never be the reason a real user
// gets a 429.
export async function isRateLimited(name: RateLimitName, identity: string): Promise<boolean> {
  const limit = RATE_LIMITS[name];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSeconds / limit.windowSeconds) * limit.windowSeconds;
  const ttl = windowStart + limit.windowSeconds + TTL_BUFFER_SECONDS;

  try {
    // Raw identity in the key on purpose — the counter needs to be exact, and
    // the item expires via TTL anyway, so there's no retention concern here
    // (unlike the logs below, which only ever get the hash).
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `RATE#${identity}`, SK: `${limit.key}#${windowStart}` },
        UpdateExpression: "ADD requestCount :one SET expiresAt = if_not_exists(expiresAt, :ttl)",
        ExpressionAttributeValues: { ":one": 1, ":ttl": ttl },
        ReturnValues: "UPDATED_NEW",
      })
    );
    const count = (result.Attributes?.requestCount as number) ?? 0;
    return count > limit.max;
  } catch (err) {
    console.error("rate-limit counter write failed, allowing request through", {
      limit: name,
      identity: hashIdentity(identity),
      err,
    });
    // Makes the silent fail-open window visible. Must not block or throw: see
    // emitCounterFailureMetric.
    emitCounterFailureMetric();
    return false;
  }
}
