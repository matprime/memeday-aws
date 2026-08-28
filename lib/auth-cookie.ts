import { NextResponse } from "next/server";

// Cognito's own refresh token, kept in an httpOnly cookie so page JS can never
// read it. The access token stays in localStorage — it lives 60 minutes, this
// one lives 30 days (RefreshTokenValidity on the pool client), so it is the
// far more valuable of the two to leak.
//
// Path is /api/auth so the cookie is only sent to the refresh and logout
// routes, not on every feed/vote/upload request.
export const REFRESH_COOKIE = "md_rt";

const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth",
};

export function setRefreshCookie(res: NextResponse, refreshToken: string) {
  res.cookies.set({ name: REFRESH_COOKIE, value: refreshToken, ...COOKIE_OPTIONS, maxAge: REFRESH_MAX_AGE });
}

export function clearRefreshCookie(res: NextResponse) {
  res.cookies.set({ name: REFRESH_COOKIE, value: "", ...COOKIE_OPTIONS, maxAge: 0 });
}
