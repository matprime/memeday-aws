import { createHash } from "crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
function hashIdentity(identity: string): string {
  return createHash("sha256")
    .update(getEnv("WALLET_AUTH_SECRET"))
    .update(identity)
    .digest("hex")
    .slice(0, 12);
}

// x-forwarded-for is set by Vercel's own edge network from the real TCP
// connection, and Vercel is the only way to reach this deployment — there is
// no path that lets a client hand its own value straight to the function. No
// Next.js route here sets `runtime = "edge"`, so this is a Node.js function,
// where `request.ip` was removed and geo/ip helpers aren't available either;
// the header is the correct and only source for this app.
export function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
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
    return false;
  }
}
