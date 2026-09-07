import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { getMintRequest, transitionMintRequest } from "@/lib/db";
import {
  newNonce,
  nonceIsValid,
  sanitizeError,
  toMintResponse,
} from "@/lib/mint-service";
import { isValidSolanaAddress } from "@/lib/solana/verify-mint";
import { MAX_ON_CHAIN_URI_LEN } from "@/lib/nft-config";
import { SOLANA_ENABLED, SOLANA_DISABLED_MESSAGE } from "@/lib/solana/network";
import type { MintStatus } from "@/lib/types";

// Each call records the previous stage's output and marks the next stage as
// started, which is what makes the status mean "this is happening now" rather
// than "this finished a moment ago":
//
//   UPLOADING_PICTURE   picture upload is starting
//   UPLOADING_METADATA  picture is up (pictureUri), metadata upload starting
//   AWAITING_SIGNATURE  metadata is up (metadataUri) and the asset keypair is
//                       known (assetAddress) — the wallet is about to be asked
//
// Recording assetAddress on that last step, before the user signs, is what
// makes reconciliation possible later without a transaction signature.
const ALLOWED_ADVANCES: MintStatus[] = [
  "UPLOADING_PICTURE",
  "UPLOADING_METADATA",
  "AWAITING_SIGNATURE",
];

function invalidUri(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri) return "uri is required";
  if (!uri.startsWith("https://")) return "uri must be https";
  if (uri.length > MAX_ON_CHAIN_URI_LEN) {
    return `uri is too long (max ${MAX_ON_CHAIN_URI_LEN} characters)`;
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!SOLANA_ENABLED) {
    return NextResponse.json({ error: SOLANA_DISABLED_MESSAGE }, { status: 503 });
  }

  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { assetId, nonce, advance, pictureUri, metadataUri, assetAddress } = body;
  if (typeof assetId !== "string" || !assetId) {
    return NextResponse.json({ error: "assetId is required" }, { status: 400 });
  }
  if (!ALLOWED_ADVANCES.includes(advance as MintStatus)) {
    return NextResponse.json({ error: "Invalid advance" }, { status: 400 });
  }

  const existing = await getMintRequest(assetId);
  if (!existing) {
    return NextResponse.json({ error: "Mint request not found" }, { status: 404 });
  }
  if (existing.userId !== userId) {
    return NextResponse.json({ error: "ASSET_NOT_OWNED" }, { status: 403 });
  }
  if (existing.status === "CONFIRMED") {
    return NextResponse.json(toMintResponse(existing), { status: 409 });
  }
  // Single-use: the stored nonce is replaced on every successful advance, so a
  // captured request body cannot be replayed even inside the TTL window.
  if (!nonceIsValid(existing, nonce)) {
    return NextResponse.json(
      { error: "This mint request has expired. Start again." },
      { status: 409 }
    );
  }

  const target = advance as MintStatus;
  const patch: Record<string, string> = {};

  if (target === "UPLOADING_METADATA") {
    const problem = invalidUri(pictureUri);
    if (problem) return NextResponse.json({ error: `pictureUri: ${problem}` }, { status: 400 });
    patch.pictureUri = pictureUri as string;
  }

  if (target === "AWAITING_SIGNATURE") {
    const problem = invalidUri(metadataUri);
    if (problem) return NextResponse.json({ error: `metadataUri: ${problem}` }, { status: 400 });
    if (!isValidSolanaAddress(assetAddress)) {
      return NextResponse.json({ error: "Invalid assetAddress" }, { status: 400 });
    }
    patch.metadataUri = metadataUri as string;
    patch.assetAddress = assetAddress as string;
  }

  const rotated = newNonce();

  try {
    const updated = await transitionMintRequest(
      assetId,
      target,
      { ...patch, nonce: rotated.nonce, nonceExpiresAt: rotated.nonceExpiresAt },
      // attempts counts wallet prompts, so it increments only where one follows.
      { incrementAttempts: target === "AWAITING_SIGNATURE" }
    );
    return NextResponse.json({ ...toMintResponse(updated), nonce: rotated.nonce });
  } catch (err) {
    return NextResponse.json({ error: sanitizeError(err) }, { status: 409 });
  }
}
