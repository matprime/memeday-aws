"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

const STORAGE_KEY = "md_ref_by";

// Separate query param from ShareBar's own `ref=share` (see MemePageClient's
// visit_from_share tracking) — reusing `ref` for both would break that
// existing check, since it reads `ref === "share"` literally.
export function getStoredReferrerId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// Mounted once at the root layout (KAN-101), same as WalletAuthSync/AnalyticsInit.
// First-touch attribution: once a referrer id is stored, a later ?refBy on the
// same browser never overwrites it. The server independently enforces its own
// attach window (REFERRAL_ATTACH_WINDOW_HOURS in lib/points-config.ts) and
// re-validates the referrer exists, so this capture only ever supplies a
// candidate value, never a trusted one.
export function ReferralCapture() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const refBy = searchParams.get("refBy");
    if (!refBy) return;
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, refBy);
      }
    } catch {
      // Private browsing / blocked storage — referral just isn't captured.
    }
  }, [searchParams]);

  return null;
}
