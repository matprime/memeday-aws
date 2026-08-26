import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { createReport, getMemeById } from "@/lib/db";
import { getClientIp, hashIdentity, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { publishAlert } from "@/lib/sns";

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
const MAX_REASON_LENGTH = 500;

// No auth required (KAN-43): getUserIdFromRequest returns null for a missing
// or invalid token, and that's treated as an anonymous reporter rather than
// an error.
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const memeId = params.id;
  const userId = await getUserIdFromRequest(req);
  const ip = getClientIp(req);

  // Per-IP is the only layer for an anonymous caller; per-user applies in
  // addition once authenticated. No report-specific limiting logic — this is
  // the same shared helper every other rate-limited route calls.
  const checks = [isRateLimited("reportPerIp", ip)];
  if (userId) checks.push(isRateLimited("reportPerUser", userId));
  const limited = await Promise.all(checks);
  if (limited.some(Boolean)) {
    return rateLimitResponse();
  }

  let reason: string;
  try {
    const body = await req.json();
    reason = typeof body.reason === "string" ? body.reason.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: "reason is required" }, { status: 400 });
  }
  reason = reason.slice(0, MAX_REASON_LENGTH);

  const meme = await getMemeById(memeId);
  if (!meme) {
    return NextResponse.json({ error: "Meme not found" }, { status: 404 });
  }

  // identity = userId when authenticated, else IP — same discriminator the
  // rate limiter above just checked against, hashed with the existing salted
  // helper so the SK never carries a raw IP or Cognito sub.
  const identity = userId ?? ip;
  const { isFirstReport } = await createReport({
    memeId,
    identityHash: hashIdentity(identity),
    reporterId: userId ?? undefined,
    reason,
  });

  // Notify on first report only. Never reveal to the caller whether this was
  // a duplicate — the response is identical either way.
  if (isFirstReport) {
    await publishAlert(
      `MemeDay report: ${memeId}`,
      [
        `memeId: ${memeId}`,
        `creatorId: ${meme.creatorId}`,
        `reason: ${reason}`,
        `timestamp: ${new Date().toISOString()}`,
        `${APP_URL}/admin/reports`,
      ].join("\n")
    );
  }

  return NextResponse.json({ success: true });
}
