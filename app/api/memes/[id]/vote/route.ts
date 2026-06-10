import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { voteMeme } from "@/lib/db";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const voted = await voteMeme(params.id, userId);
    return NextResponse.json({ success: true, alreadyVoted: !voted });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
