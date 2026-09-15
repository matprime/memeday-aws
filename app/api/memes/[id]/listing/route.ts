import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { getMemeById, setMemeListingPrice } from "@/lib/db";
import { isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

// Prices a minted meme. Separate from the mint state machine on purpose: a
// price is a property of the meme, and /api/mint/confirm is also reached by
// paths (a resumed confirm, reconciliation) where no one is setting a price.
//
// Minting at post time carries its price through /api/memes instead. This is
// the mint-later route's equivalent — without it a meme minted from its own
// page had an NFT and no price, so neither the badge nor the Buy button
// appeared.
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (await isRateLimited("listingPerUser", userId)) {
    return rateLimitResponse();
  }

  let body: { listingPrice?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const price = body.listingPrice;
  // An unparseable or absurd price must not reach the item: it is rendered as
  // a SOL amount and read back as a number by the Buy path.
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 1_000_000) {
    return NextResponse.json(
      { error: "listingPrice must be a number greater than 0" },
      { status: 400 }
    );
  }

  const meme = await getMemeById(params.id);
  if (!meme) {
    return NextResponse.json({ error: "Meme not found" }, { status: 404 });
  }
  // Same ownership test the mint routes apply (see lib/mint-service.ts).
  if (meme.creatorId !== userId && meme.ownerId !== userId) {
    return NextResponse.json({ error: "ASSET_NOT_OWNED" }, { status: 403 });
  }
  if (!meme.nftMint) {
    return NextResponse.json({ error: "This meme has no NFT to price" }, { status: 409 });
  }

  const updated = await setMemeListingPrice(params.id, price);
  if (!updated) {
    return NextResponse.json({ error: "This meme has no NFT to price" }, { status: 409 });
  }
  return NextResponse.json({ listingPrice: price });
}
