import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { voteMeme } from "@/lib/db";
import { isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Votes only get a per-user limit, no per-IP layer — a vote is a dedupe'd
  // one-per-meme action already, so a shared IP isn't a Sybil risk the way
  // uploads/comments are.
  if (await isRateLimited("votePerUser", userId)) {
    return rateLimitResponse();
  }

  try {
    const voted = await voteMeme(params.id, userId);
    return NextResponse.json({ success: true, alreadyVoted: !voted });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
