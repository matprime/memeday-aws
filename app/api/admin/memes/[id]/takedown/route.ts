import { NextResponse } from "next/server";
import { getUserGroupsFromRequest, getUserIdFromRequest } from "@/lib/cognito";
import { takedownMeme } from "@/lib/db";

// Independent re-check (KAN-43): the admin page's own group check is UX
// only, this is the real gate. Same 404-not-403 shape as GET /api/admin/reports
// so a non-member sees no sign the route exists.
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const [userId, groups] = await Promise.all([
    getUserIdFromRequest(req),
    getUserGroupsFromRequest(req),
  ]);
  if (!userId || !groups.includes("admins")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const removed = await takedownMeme(params.id, userId);
  if (!removed) {
    return NextResponse.json({ error: "Meme not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
