import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { createMeme, getUserById } from "@/lib/db";

export async function POST(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { s3Key, caption, isNFT, nftMint, listingPrice } = body;

    if (!s3Key || !caption) {
      return NextResponse.json({ error: "s3Key and caption are required" }, { status: 400 });
    }

    // Denormalize creator wallet for Solana Pay tips
    const creator = await getUserById(userId);
    const meme = await createMeme({
      creatorId: userId,
      creatorWalletAddr: creator?.walletAddr,
      s3Key,
      caption,
      nftMint: nftMint ?? undefined,
      listingPrice: listingPrice ?? undefined,
      isNFT: isNFT ?? false,
    });

    return NextResponse.json({ meme });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
