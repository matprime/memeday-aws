import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import {
  confirmMintRequest,
  getMintRequest,
  setMemeNftMint,
  transitionMintRequest,
} from "@/lib/db";
import {
  onChainName,
  resolveAsset,
  sanitizeError,
  toMintResponse,
} from "@/lib/mint-service";
import { verifyMint } from "@/lib/solana/verify-mint";
import { SOLANA_ENABLED, SOLANA_DISABLED_MESSAGE } from "@/lib/solana/network";
import { getClientIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

// Nothing reaches CONFIRMED on the client's say-so. The client tells us it
// thinks the mint landed; this route asks the chain and believes only that.
//
// Deliberately does NOT require a nonce: signing and confirmation can take
// minutes, far longer than a nonce window, and the real gate here is the
// on-chain check rather than proof of a recent prepare.
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

  let body: { assetId?: unknown; signature?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { assetId } = body;
  const signature = typeof body.signature === "string" ? body.signature : undefined;
  if (typeof assetId !== "string" || !assetId) {
    return NextResponse.json({ error: "assetId is required" }, { status: 400 });
  }

  let existing = await getMintRequest(assetId);
  if (!existing) {
    return NextResponse.json({ error: "Mint request not found" }, { status: 404 });
  }
  if (existing.userId !== userId) {
    return NextResponse.json({ error: "ASSET_NOT_OWNED" }, { status: 403 });
  }

  // Idempotent. A retried confirm — or two tabs confirming at once — returns
  // the same answer instead of doing the work twice.
  if (existing.status === "CONFIRMED") {
    return NextResponse.json(toMintResponse(existing), { status: 200 });
  }
  if (existing.status === "FAILED") {
    return NextResponse.json(toMintResponse(existing), { status: 409 });
  }
  if (!existing.assetAddress || !existing.metadataUri || !existing.pictureUri) {
    return NextResponse.json(
      { error: "This mint request was never prepared for signing." },
      { status: 409 }
    );
  }

  // The transaction has been submitted, so record that before we go looking
  // for it. If everything after this dies, the request is left in MINTING with
  // an assetAddress, which is exactly what reconciliation needs to finish it.
  if (existing.status === "AWAITING_SIGNATURE") {
    try {
      existing = await transitionMintRequest(assetId, "MINTING", { txSignature: signature });
    } catch (err) {
      return NextResponse.json({ error: sanitizeError(err) }, { status: 409 });
    }
  }

  const resolved = await resolveAsset(assetId, userId);
  // ALREADY_MINTED here means the meme row already carries a mint address —
  // a previous confirm got further than we thought. Fall through to the chain
  // check rather than treating it as an error.
  const caption =
    "asset" in resolved ? resolved.asset.caption : undefined;
  if (caption === undefined) {
    return NextResponse.json(
      { error: "The asset for this mint request is no longer available." },
      { status: 409 }
    );
  }

  const verdict = await verifyMint(
    {
      assetAddress: existing.assetAddress,
      ownerWallet: existing.ownerWallet,
      metadataUri: existing.metadataUri,
      expectedName: onChainName(caption),
      expectedImageUri: existing.pictureUri,
    },
    signature ?? existing.txSignature
  );

  if (verdict.outcome === "rejected") {
    // Two failures that must not be recorded as a failed mint: the asset may
    // simply not have landed yet, and the RPC may be unreachable. Both leave
    // the request in MINTING so a retry or the reconciler can finish it —
    // marking FAILED here would strand a real NFT as unrecorded.
    if (verdict.reason === "ASSET_NOT_FOUND" || verdict.reason === "RPC_UNAVAILABLE") {
      return NextResponse.json(
        { ...toMintResponse(existing), pending: true, reason: verdict.reason },
        { status: 202 }
      );
    }
    try {
      const failed = await transitionMintRequest(assetId, "FAILED", {
        lastError: verdict.reason,
      });
      return NextResponse.json({ ...toMintResponse(failed), reason: verdict.reason }, { status: 422 });
    } catch (err) {
      return NextResponse.json({ error: sanitizeError(err) }, { status: 409 });
    }
  }

  try {
    const confirmed = await confirmMintRequest(assetId, {
      mintAddress: verdict.mintAddress,
      txSignature: signature ?? existing.txSignature ?? "",
    });
    // Mint-later: the meme row exists, so stamp it. Mint-at-post: no meme row
    // yet, and app/api/memes reads the confirmed request at finalize instead.
    // Conditional inside setMemeNftMint, so this can never overwrite.
    await setMemeNftMint(assetId, verdict.mintAddress);
    return NextResponse.json(toMintResponse(confirmed), { status: 200 });
  } catch (err) {
    // The NFT exists on-chain but we failed to record it. Report it as still
    // pending rather than failed: the row keeps its assetAddress, so the
    // reconciler will pick it up and finish the job.
    return NextResponse.json(
      { ...toMintResponse(existing), pending: true, error: sanitizeError(err) },
      { status: 202 }
    );
  }
}
