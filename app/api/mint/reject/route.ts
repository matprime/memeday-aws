import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { getMintRequest, transitionMintRequest } from "@/lib/db";
import { sanitizeError, toMintResponse } from "@/lib/mint-service";
import { SOLANA_ENABLED, SOLANA_DISABLED_MESSAGE } from "@/lib/solana/network";

// The user declined the wallet prompt. No transaction was submitted, the
// uploaded picture and metadata stay attached to the request, and the client
// may ask for a new signature later.
//
// This route never re-opens the wallet and never schedules a retry. Retrying
// is a deliberate user action, which is the whole point of a rejection being
// its own status rather than a failure.
export async function POST(request: NextRequest) {
  if (!SOLANA_ENABLED) {
    return NextResponse.json({ error: SOLANA_DISABLED_MESSAGE }, { status: 503 });
  }

  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { assetId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { assetId } = body;
  if (typeof assetId !== "string" || !assetId) {
    return NextResponse.json({ error: "assetId is required" }, { status: 400 });
  }

  const existing = await getMintRequest(assetId);
  if (!existing) {
    return NextResponse.json({ error: "Mint request not found" }, { status: 404 });
  }
  if (existing.userId !== userId) {
    return NextResponse.json({ error: "ASSET_NOT_OWNED" }, { status: 403 });
  }
  // A rejection arriving after the mint actually landed is the client being
  // wrong, not the chain. Never walk a confirmed NFT backwards.
  if (existing.status === "CONFIRMED") {
    return NextResponse.json(toMintResponse(existing), { status: 409 });
  }
  // Already rejected — treat a repeat as success so a retried request does not
  // surface an error the user cannot act on.
  if (existing.status === "SIGNATURE_REJECTED") {
    return NextResponse.json(toMintResponse(existing), { status: 200 });
  }

  try {
    const rejected = await transitionMintRequest(assetId, "SIGNATURE_REJECTED");
    return NextResponse.json(toMintResponse(rejected), { status: 200 });
  } catch (err) {
    return NextResponse.json({ error: sanitizeError(err) }, { status: 409 });
  }
}
