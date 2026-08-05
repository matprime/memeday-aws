import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { getPendingUpload } from "@/lib/db";

export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pending = await getPendingUpload(params.id);
  if (!pending || pending.creatorId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ status: pending.status, reason: pending.reason ?? null });
}
