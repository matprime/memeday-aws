import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import {
  createMintRequest,
  getMintRequest,
  refreshMintNonce,
  MintRequestExistsError,
} from "@/lib/db";
import {
  assertWalletBelongsToUser,
  newNonce,
  resolveAsset,
  sanitizeError,
  toMintResponse,
} from "@/lib/mint-service";
import { isValidSolanaAddress } from "@/lib/solana/verify-mint";
import { SOLANA_ENABLED, SOLANA_DISABLED_MESSAGE, SOLANA_NETWORK } from "@/lib/solana/network";
import { getClientIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

const ASSET_PROBLEM_STATUS: Record<string, number> = {
  ASSET_NOT_FOUND: 404,
  ASSET_NOT_OWNED: 403,
  ASSET_NOT_VALIDATED: 425,
  ASSET_REJECTED: 422,
  ALREADY_MINTED: 409,
};

// Entry point for both mint-at-post and mint-later. Creates the request the
// first time and resumes it on a retry — it never creates a second one, which
// is what keeps "one asset, at most one NFT" true across retries.
//
// This route deliberately does not cause a wallet prompt. It only establishes
// that the caller may mint this asset and hands back a short-lived nonce.
export async function POST(request: NextRequest) {
  if (!SOLANA_ENABLED) {
    return NextResponse.json({ error: SOLANA_DISABLED_MESSAGE }, { status: 503 });
  }

  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [userLimited, ipLimited] = await Promise.all([
    isRateLimited("mintPerUser", userId),
    isRateLimited("mintPerIp", getClientIp(request)),
  ]);
  if (userLimited || ipLimited) return rateLimitResponse();

  let body: { assetId?: unknown; ownerWallet?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { assetId, ownerWallet } = body;
  if (typeof assetId !== "string" || !assetId) {
    return NextResponse.json({ error: "assetId is required" }, { status: 400 });
  }
  // Validated before any upload or transaction construction, per the security
  // requirements — an unusable address must fail here, not after the user has
  // already paid to store an image permanently.
  if (!isValidSolanaAddress(ownerWallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }
  if (!(await assertWalletBelongsToUser(userId, ownerWallet))) {
    return NextResponse.json(
      { error: "That wallet is not linked to your account" },
      { status: 403 }
    );
  }

  const resolved = await resolveAsset(assetId, userId);
  if ("problem" in resolved) {
    return NextResponse.json(
      { error: resolved.problem },
      { status: ASSET_PROBLEM_STATUS[resolved.problem] ?? 400 }
    );
  }

  const nonce = newNonce();

  try {
    await createMintRequest({ assetId, userId, ownerWallet, network: SOLANA_NETWORK });
    const armed = await refreshMintNonce(assetId, "PENDING", nonce);
    return NextResponse.json({ ...toMintResponse(armed), nonce: nonce.nonce }, { status: 201 });
  } catch (err) {
    if (!(err instanceof MintRequestExistsError)) {
      return NextResponse.json({ error: sanitizeError(err) }, { status: 500 });
    }
  }

  // Resume path: a request already exists for this asset.
  const existing = await getMintRequest(assetId);
  if (!existing) {
    return NextResponse.json({ error: sanitizeError(null) }, { status: 500 });
  }
  // Ownership is re-checked against the stored request, not only the asset.
  // The request records who started it and which wallet it is for, and neither
  // may change underneath a retry.
  if (existing.userId !== userId || existing.ownerWallet !== ownerWallet) {
    return NextResponse.json({ error: "ASSET_NOT_OWNED" }, { status: 403 });
  }
  if (existing.status === "CONFIRMED") {
    return NextResponse.json(toMintResponse(existing), { status: 409 });
  }
  if (existing.status === "FAILED") {
    return NextResponse.json(
      { ...toMintResponse(existing), error: "This mint failed and cannot be retried." },
      { status: 409 }
    );
  }

  try {
    const armed = await refreshMintNonce(assetId, existing.status, nonce);
    return NextResponse.json({ ...toMintResponse(armed), nonce: nonce.nonce }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ error: sanitizeError(err) }, { status: 409 });
  }
}
