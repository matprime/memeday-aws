"use client";

import { useEffect } from "react";
import { initAnalytics } from "@/lib/analytics";
import { useSolanaConfig } from "@/components/WalletProvider";

// Headless singleton mounted in the root layout. PostHog captures $pageview
// itself on history changes, so there is nothing else to do per navigation.
export function AnalyticsInit() {
  const { network } = useSolanaConfig();

  useEffect(() => {
    initAnalytics(network);
  }, [network]);

  return null;
}
