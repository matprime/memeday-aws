"use client";

import { useEffect } from "react";
import { getAccessToken } from "@/lib/session";

// Reconciles the persisted access token with Cognito once per page load.
//
// The store rehydrates a token from localStorage that may be hours old, and
// every logged-in check in the UI keys off that token's presence. Without this
// the app renders as signed in on top of a dead session — the state the
// "Failed to get upload URL" bug lived in. Refreshing here either renews the
// session silently or clears it, so what the UI shows is true.
export function SessionSync() {
  useEffect(() => {
    void getAccessToken();
  }, []);

  return null;
}
