import { NextRequest, NextResponse } from "next/server";
import { createNftMetadata } from "@/lib/db";
import { getUserIdFromRequest } from "@/lib/cognito";
import { isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { metadataBaseUrl } from "@/lib/metadata-url";

// Was unauthenticated and unrate-limited: anyone could write rows into the
// table indefinitely. The GET counterpart stays public on purpose — already
// minted NFTs carry on-chain uris pointing at it, and those must never break.
export async function POST(request: NextRequest) {
  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (await isRateLimited("nftMetadataPerUser", userId)) {
    return rateLimitResponse();
  }

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
