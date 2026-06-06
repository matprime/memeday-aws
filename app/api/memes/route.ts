import { NextResponse } from "next/server";
import { createMeme } from "@/lib/db";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { creator_wallet, image_url, caption, price, is_for_sale, is_nft, mint_address } = body;

    if (!creator_wallet || !image_url || !caption) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const meme = await createMeme({
      creator_wallet,
      image_url,
      caption,
      price: price ?? null,
      is_for_sale: is_for_sale ?? false,
      is_nft: is_nft ?? false,
      mint_address: mint_address ?? null,
    });
    return NextResponse.json({ meme });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
