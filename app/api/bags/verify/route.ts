import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { getUserById, getVerifiedBagsToken, createVerifiedBagsToken, BagsTokenAlreadyBoundError } from "@/lib/db";
import { getClientIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { verifyBagsLaunch, BagsVerifyError, type VerifyLaunchSuccess } from "@/lib/bags-server";

// Read-only against Bags and spends nothing, unlike the launch action itself
// (a link-out that opens a real launch flow on bags.fm, live only). That's
// why this route has no SOLANA_ENABLED / mainnet gate of its own: off
// mainnet it still runs, just through the simulated branch inside
// verifyBagsLaunch (see lib/bags-server.ts) instead of calling Bags.
export async function POST(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [userLimited, ipLimited] = await Promise.all([
    isRateLimited("bagsVerifyPerUser", userId),
    isRateLimited("bagsVerifyPerIp", getClientIp(req)),
  ]);
  if (userLimited || ipLimited) {
    return rateLimitResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { tokenMint, name, symbol } = (body ?? {}) as Record<string, unknown>;

  // name/symbol are what the creator entered when they opened the launch —
  // Bags itself doesn't return them from either GET below, so they are
  // stored as-supplied and are NOT independently verified against Bags.
  if (typeof name !== "string" || !name.trim() || name.length > 32) {
    return NextResponse.json({ error: "name is required (max 32 chars)" }, { status: 400 });
  }
  if (typeof symbol !== "string" || !symbol.trim() || symbol.length > 10) {
    return NextResponse.json({ error: "symbol is required (max 10 chars)" }, { status: 400 });
  }
  // Absent entirely in the simulated case (see BagsLaunchClaim.tsx) — only
  // required once verifyBagsLaunch actually needs to call Bags.
  const tokenMintValue = typeof tokenMint === "string" ? tokenMint : undefined;
  if (tokenMint !== undefined && tokenMintValue === undefined) {
    return NextResponse.json({ error: "tokenMint must be a string" }, { status: 400 });
  }

  const user = await getUserById(userId);

  let result: VerifyLaunchSuccess;
  try {
    result = await verifyBagsLaunch({
      callerWallet: user?.walletAddr,
      tokenMint: tokenMintValue,
      name,
      symbol,
    });
  } catch (err) {
    if (err instanceof BagsVerifyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // One token per creator is a permanent, one-time binding (KAN-79). Checked
  // here first so a double click or a retry on the same mint is a safe no-op
  // (200, no write) instead of an error, and so a legacy TOKEN#<mint> row
  // from before this change (no TOKEN#PRIMARY for the DB condition to catch)
  // is still rejected. The DB condition in createVerifiedBagsToken stays too
  // — this pre-check alone is racy.
  const existing = await getVerifiedBagsToken(userId);
  if (existing) {
    if (existing.tokenMint === result.tokenMint) {
      return NextResponse.json({ token: existing, simulated: result.simulated });
    }
    return NextResponse.json(
      { error: "This account is already bound to a Bags token. The binding is permanent and cannot be changed." },
      { status: 409 }
    );
  }

  let token;
  try {
    token = await createVerifiedBagsToken({
      creatorId: userId,
      tokenMint: result.tokenMint,
      symbol: symbol.trim(),
      name: name.trim(),
      partnerAttributed: result.partnerAttributed,
    });
  } catch (err) {
    if (err instanceof BagsTokenAlreadyBoundError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  return NextResponse.json({ token, simulated: result.simulated });
}
