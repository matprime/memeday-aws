import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { addComment, getUserById } from "@/lib/db";
import { getClientIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { meme_id, body: text } = body;

    if (!meme_id || !text?.trim()) {
      return NextResponse.json({ error: "meme_id and body are required" }, { status: 400 });
    }

    // Two-layer check, same as upload-url: per-user is the real limit, per-IP
    // is a Sybil ceiling. Both counters increment on every request regardless
    // of which one already failed (see lib/rate-limit-config.ts).
    const [userLimited, ipLimited] = await Promise.all([
      isRateLimited("commentPerUser", userId),
      isRateLimited("commentPerIp", getClientIp(req)),
    ]);
    if (userLimited || ipLimited) {
      return rateLimitResponse();
    }

    const user = await getUserById(userId);
    const comment = await addComment({
      memeId: meme_id,
      userId,
      walletAddr: user?.walletAddr,
      body: text.trim(),
    });

    return NextResponse.json({ comment });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
