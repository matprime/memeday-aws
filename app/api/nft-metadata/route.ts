import { NextRequest, NextResponse } from "next/server";
import { createNftMetadata } from "@/lib/db";
import { getUserIdFromRequest } from "@/lib/cognito";
import { isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

// The returned uri is minted into an immutable asset, so a misconfigured
// NEXT_PUBLIC_APP_URL must not reach it. A Vercel project with the literal
// value "https://$VERCEL_URL" (the shell form, which Vercel does not expand)
// produced an NFT whose metadata nobody can fetch. The request origin is
// always right for the deployment that is serving the call, so it is the
// fallback whenever the env var is not a usable https URL.
function metadataBaseUrl(request: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (env) {
    try {
      const { protocol, hostname } = new URL(env);
      if (protocol === "https:" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname)) return env;
    } catch {
      // fall through to the request origin
    }
    console.warn(`Ignoring unusable NEXT_PUBLIC_APP_URL: ${env}`);
  }
  return request.nextUrl.origin;
}

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
