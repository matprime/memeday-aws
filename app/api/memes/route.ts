import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { finalizeMeme, getPendingUpload } from "@/lib/db";

export async function POST(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { pendingId, isNFT, nftMint, listingPrice } = body;

    if (!pendingId) {
      return NextResponse.json({ error: "pendingId is required" }, { status: 400 });
    }

    // Re-check server-side: only a pending upload the S3Handler Lambda has
    // already validated (status: "active") may become a real, feed-visible meme.
    const pending = await getPendingUpload(pendingId);
    if (!pending || pending.creatorId !== userId) {
      return NextResponse.json({ error: "Pending upload not found" }, { status: 404 });
    }
    if (pending.status === "rejected") {
      return NextResponse.json(
        { error: `Upload rejected: ${pending.reason ?? "invalid file"}` },
        { status: 422 }
      );
    }
    if (pending.status !== "active") {
      return NextResponse.json({ error: "Upload still being validated" }, { status: 425 });
    }

    const meme = await finalizeMeme(pending, {
      nftMint: nftMint ?? undefined,
      listingPrice: listingPrice ?? undefined,
      isNFT: isNFT ?? false,
    });

    return NextResponse.json({ meme });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
