import { NextResponse } from "next/server";
import { clearRefreshCookie } from "@/lib/auth-cookie";

// Drops the refresh cookie so a signed-out browser cannot mint new access
// tokens. The access token itself is cleared client-side and dies within the
// hour on its own.
export async function POST() {
  const res = NextResponse.json({ ok: true });
  clearRefreshCookie(res);
  return res;
}
