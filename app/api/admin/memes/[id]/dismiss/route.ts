import { NextResponse } from "next/server";
import { getUserGroupsFromRequest, getUserIdFromRequest } from "@/lib/cognito";
import { dismissReport } from "@/lib/db";

// Independent re-check (KAN-43), same shape as POST .../takedown: the admin
// page's own group check is UX only, this is the real gate. 404, not 403, so
// a non-member sees no sign the route exists.
//
// Dismiss only deletes the REPORTQUEUE#GLOBAL item, so it never notifies
// (nothing happened to the content) and there's no status/existence to
// re-check on the meme itself. StreamHandler only reacts to REPORT# inserts,
// not to this delete, so a meme reported again after being dismissed will
// recreate the queue item on its own. That's intended, not a bug: a fresh
// report after review deserves a fresh look, so this route deliberately adds
// no suppression state to prevent it from reappearing.
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const [userId, groups] = await Promise.all([
    getUserIdFromRequest(req),
    getUserGroupsFromRequest(req),
  ]);
  if (!userId || !groups.includes("admins")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await dismissReport(params.id);
  return NextResponse.json({ success: true });
}
