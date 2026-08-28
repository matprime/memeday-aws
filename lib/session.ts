"use client";

import { useAppStore } from "./store";

// Renew this far before the token actually dies, so a request in flight when
// the clock rolls over doesn't land on the server already expired.
const SKEW_SECONDS = 60;

// De-dupes concurrent refreshes: a page can fire several authed requests at
// once and they'd otherwise each burn a Cognito call.
let inFlight: Promise<string | null> | null = null;

// Reads `exp` out of a Cognito JWT without verifying the signature. Same
// rationale as decodeJwtSub in store.ts — this only decides whether to bother
// refreshing. The server verifies the token properly on every request.
function decodeJwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

export function isTokenFresh(token: string | null): boolean {
  if (!token) return false;
  const exp = decodeJwtExp(token);
  return exp !== null && exp - SKEW_SECONDS > Date.now() / 1000;
}

async function refresh(): Promise<string | null> {
  const { authMethod, authEmail, setCognitoToken } = useAppStore.getState();
  try {
    const res = await fetch("/api/auth/refresh", { method: "POST" });
    if (res.status === 401) {
      // Refresh token is gone or expired — this is a genuine logout.
      setCognitoToken(null);
      return null;
    }
    if (!res.ok) {
      // 429/500: transient. Keep the session and let the caller fail this one
      // request rather than signing the user out over a blip.
      return null;
    }
    const { accessToken } = await res.json();
    setCognitoToken(accessToken, authMethod ?? undefined, authEmail ?? undefined);
    return accessToken;
  } catch {
    // Offline or aborted — same reasoning as above, don't destroy the session.
    return null;
  }
}

// The only way any component should obtain a token for an API call. Returns a
// live token, refreshing via Cognito first if the stored one has expired, or
// null if the user really is signed out.
export async function getAccessToken(): Promise<string | null> {
  const token = useAppStore.getState().cognitoToken;
  if (isTokenFresh(token)) return token;
  // No token at all means signed out; there is nothing to refresh and we don't
  // want every anonymous page load hitting the refresh route.
  if (!token) return null;

  if (!inFlight) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

// Ends the session in both places it lives: the access token in the store and
// the refresh cookie on the server.
export async function signOut(): Promise<void> {
  useAppStore.getState().setCognitoToken(null);
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Cookie will expire on its own; the local session is already gone.
  }
}
