"use client";

import { useEffect } from "react";
import { initAnalytics } from "@/lib/analytics";

// Headless singleton mounted in the root layout. PostHog captures $pageview
// itself on history changes, so there is nothing else to do per navigation.
export function AnalyticsInit() {
  useEffect(() => {
    initAnalytics();
  }, []);

  return null;
}
