import { NextResponse } from "next/server";
import { addComment } from "@/lib/db";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { meme_id, user_wallet, text } = body;

    if (!meme_id || !user_wallet || !text?.trim()) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const comment = await addComment({ meme_id, user_wallet, text: text.trim() });
    return NextResponse.json({ comment });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
