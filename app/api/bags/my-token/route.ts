import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { getVerifiedBagsToken, getVerifiedBagsTokenForMeme } from "@/lib/db";

// Decides launch button vs token card. With ?memeId it answers "does THIS meme
// have a token" — the question the post-meme success screen asks, and the one
// that used to be answered creator-wide, which is why an earlier meme's token
// card followed the creator onto every later meme (KAN-11). Without it, the
// creator-level question the profile asks.
export async function GET(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const memeId = new URL(req.url).searchParams.get("memeId");
  const token = memeId
    ? await getVerifiedBagsTokenForMeme(userId, memeId)
    : await getVerifiedBagsToken(userId);
  return NextResponse.json({ token });
}
