import { NextResponse } from "next/server";
import { getUserIdFromRequest, getWalletAddressFromRequest } from "@/lib/cognito";
import {
  getMemeById,
  getVerifiedBagsTokenForMeme,
  getVerifiedBagsTokensByCreator,
  createVerifiedBagsToken,
  BagsTokenAlreadyBoundError,
} from "@/lib/db";
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

  // Bags token creation is wallet-only (KAN-75): callerWallet comes from the
  // token's server-verified username, never from user.walletAddr, which is
  // client-asserted and only proven for tipping (see lib/wallet-signature.ts,
  // POST /api/users/wallet). This gate applies before any Bags API call, and
  // before the rate-limit counters below so a non-wallet caller never spends
  // that budget.
  const callerWallet = await getWalletAddressFromRequest(req);
  if (!callerWallet) {
    return NextResponse.json(
      { error: "Connect and verify a wallet to launch a Bags token" },
      { status: 403 }
    );
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
  const { tokenMint, name, symbol, memeId } = (body ?? {}) as Record<string, unknown>;

  // A token belongs to one meme, and only that meme's uploader may bind it
  // (KAN-11). Checked against the meme row, not against anything the client
  // claims, and before the Bags call so an impostor spends none of that budget.
  if (typeof memeId !== "string" || !memeId) {
    return NextResponse.json({ error: "memeId is required" }, { status: 400 });
  }
  const meme = await getMemeById(memeId);
  if (!meme) {
    return NextResponse.json({ error: "Meme not found" }, { status: 404 });
  }
  if (meme.creatorId !== userId) {
    return NextResponse.json(
      { error: "Only the creator of this meme can launch its token" },
      { status: 403 }
    );
  }

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

  let result: VerifyLaunchSuccess;
  try {
    result = await verifyBagsLaunch({
      callerWallet,
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

  // One token per meme is a permanent, one-time binding. Checked here first so
  // a double click or a retry on the same mint is a safe no-op (200, no write)
  // instead of an error. The DB condition in createVerifiedBagsToken stays too
  // — this pre-check alone is racy.
  const existing = await getVerifiedBagsTokenForMeme(userId, memeId);
  if (existing) {
    if (existing.tokenMint === result.tokenMint) {
      return NextResponse.json({ token: existing, simulated: result.simulated });
    }
    return NextResponse.json(
      { error: "This meme is already bound to a Bags token. The binding is permanent and cannot be changed." },
      { status: 409 }
    );
  }

  // Per-meme binding would otherwise be free to defeat: pasting one mint on
  // every meme would claim them all for the same token. A mint belongs to the
  // first meme that claimed it.
  const claimed = (await getVerifiedBagsTokensByCreator(userId)).find(
    (t) => t.tokenMint === result.tokenMint
  );
  if (claimed) {
    return NextResponse.json(
      { error: "That token is already bound to another one of your memes." },
      { status: 409 }
    );
  }

  let token;
  try {
    token = await createVerifiedBagsToken({
      creatorId: userId,
      memeId,
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
