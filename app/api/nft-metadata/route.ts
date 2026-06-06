import { NextRequest, NextResponse } from "next/server";
import { createNftMetadata } from "@/lib/db";

function metadataBaseUrl(request: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (env) return env;
  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, image, description } = body;

    if (!image || typeof image !== "string") {
      return NextResponse.json({ error: "missing image" }, { status: 400 });
    }

    const { id } = await createNftMetadata({
      name: (name ?? "Meme NFT").slice(0, 32),
      image_url: image,
      description: description ?? "Meme NFT — MemeDay on Solana",
    });

    const uri = `${metadataBaseUrl(request)}/api/nft-metadata/${id}`;
    return NextResponse.json({ id, uri });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
