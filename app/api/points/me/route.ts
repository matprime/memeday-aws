import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { getUserPointsTotals } from "@/lib/db";

export async function GET(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const totals = await getUserPointsTotals(userId);
  return NextResponse.json(totals);
}
