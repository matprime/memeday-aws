import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { getMintRequest } from "@/lib/db";
import { toMintResponse } from "@/lib/mint-service";

// Status poll. Readable only by the user who owns the request — a mint request
// carries a wallet address and an asset id, so it is not public data.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { assetId } = await params;
  const existing = await getMintRequest(assetId);
  if (!existing) {
    return NextResponse.json({ error: "Mint request not found" }, { status: 404 });
  }
  if (existing.userId !== userId) {
    // 404 rather than 403: a user who does not own it should not learn that a
    // mint request for this asset exists at all.
    return NextResponse.json({ error: "Mint request not found" }, { status: 404 });
  }

  return NextResponse.json(toMintResponse(existing));
}
