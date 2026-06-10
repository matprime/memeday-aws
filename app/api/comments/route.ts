import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { addComment, getUserById } from "@/lib/db";

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
