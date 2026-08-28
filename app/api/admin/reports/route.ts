import { NextResponse } from "next/server";
import { getUserGroupsFromRequest, getUserIdFromRequest } from "@/lib/cognito";
import { getOpenReports } from "@/lib/db";

// 404, not 403, for a non-member (KAN-43): the route's existence isn't
// revealed to a caller who isn't in the admins group.
export async function GET(req: Request) {
  const [userId, groups] = await Promise.all([
    getUserIdFromRequest(req),
    getUserGroupsFromRequest(req),
  ]);
  if (!userId || !groups.includes("admins")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const reports = await getOpenReports();
  return NextResponse.json({ reports });
}
