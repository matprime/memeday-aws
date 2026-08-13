"use client";

import posthog from "posthog-js";

// Canonical event vocabulary — the single source of truth for event names.
// Mirrored in docs/ANALYTICS_EVENTS.md; test/analytics-events.test.js fails if a
// name here is missing from that doc.
export const EVENTS = {
  signupCompleted: "signup_completed",
  memeUploaded: "meme_uploaded",
  voteCast: "vote_cast",
  commentPosted: "comment_posted",
  tipQrShown: "tip_qr_shown",
  tipLinkOpened: "tip_link_opened",
  mintStarted: "mint_started",
  mintConfirmed: "mint_confirmed",
  // Not emitted yet — the share feature doesn't exist. Reserved here so the
  // share-tracking task uses these exact names.
  shareClicked: "share_clicked",
  visitFromShare: "visit_from_share",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

type EventProperties = Record<string, string | number | boolean | null | undefined>;

let initialized = false;

// Called once from <AnalyticsInit />, which reads the network from
// SolanaConfigContext (lib/solana/network.ts is the source of truth).
// Without NEXT_PUBLIC_POSTHOG_KEY this stays uninitialized and every track()
// call below becomes a no-op, so local dev and tests never send events.
export function initAnalytics(network: string) {
  if (initialized || typeof window === "undefined") return;

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com",
    // Opts into the modern defaults, which capture $pageview on History API
    // changes — required for App Router client-side navigation.
    defaults: "2025-05-24",
    // localStorage only: no analytics cookies, which is what the footer note says.
    persistence: "localStorage",
    // Only the events declared in EVENTS, plus $pageview. Autocapture logged every
    // click/input/form ("clicked button with text …"), which buried the deliberate
    // events without answering a question we're asking.
    autocapture: false,
    capture_performance: false,
  });

  // PostHog's free tier allows one project, so local dev and production share
  // it. Filter insights on environment = "production" to keep dev clicks out of
  // the funnels. Next.js sets NODE_ENV automatically — nothing to configure.
  posthog.register({
    platform: "web",
    network,
    environment: process.env.NODE_ENV,
  });
  initialized = true;
}

export function track(event: EventName, properties?: EventProperties) {
  if (!initialized) return;
  posthog.capture(event, properties);
}
