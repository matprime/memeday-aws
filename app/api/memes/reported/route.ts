import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { getReportedMemeIds } from "@/lib/db";
import { hashIdentity } from "@/lib/rate-limit";

// Backs the "hide from reporter" feed filter for authenticated users (KAN-43).
// Anonymous callers get an empty list back — that case is handled purely
// client-side (decision 16), never from server state.
export async function GET(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ reportedMemeIds: [] });
  }

  const idsParam = req.nextUrl.searchParams.get("ids") ?? "";
  const memeIds = idsParam.split(",").map((id) => id.trim()).filter(Boolean);

  const reportedMemeIds = await getReportedMemeIds(hashIdentity(userId), memeIds);
  return NextResponse.json({ reportedMemeIds });
}
