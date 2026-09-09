import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { getVerifiedBagsToken } from "@/lib/db";

// Backs the "one token per user, in the UI only" rule (KAN-29 follow-up,
// correction 3): the caller checks this before deciding whether to show the
// launch button or the token card. Not enforced here or in the DB — see
// lib/db.ts createVerifiedBagsToken.
export async function GET(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = await getVerifiedBagsToken(userId);
  return NextResponse.json({ token });
}
