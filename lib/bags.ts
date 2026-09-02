"use client";

/**
 * Bags.fm integration (KAN-29).
 *
 * Token launch is a link-out to Bags, not an in-app action: MemeDay never
 * signs a launch transaction. This file holds only the pieces that are safe
 * to run on either side of the network boundary (no secrets). The server-only
 * API client (x-api-key, verification calls) lives in lib/bags-server.ts and
 * must never be imported from a "use client" file.
 *
 * buyCreatorToken / sellCreatorToken / getBagsTokenPrice below are unrelated,
 * pre-existing simulated in-app trading (KAN-52) and are untouched by KAN-29.
 */

import type { BagsEvent } from "./types";

// Simulated delay to mimic real network calls
const delay = (ms: number) =>
  new Promise<void>((res) => setTimeout(res, ms));

export interface BagsPurchaseResult {
  txSignature: string;
  tokenAmount: number;
  solSpent: number;
  newPrice: number;
}

const LAUNCH_INTENT_BASE = "https://bags.fm/launch?intent=true";
const MAX_NAME_LENGTH = 32;
const MAX_TICKER_LENGTH = 10;

export class BagsLaunchConfigError extends Error {}

export interface BagsLaunchIntentParams {
  name: string;
  ticker: string;
  description?: string;
  image?: string;
  website?: string;
  twitter?: string;
  partner?: string;
  partnerConfig?: string;
}

// Pure and secret-free: everything it needs comes in as arguments, so it can
// run in a client component (building the URL to open) or in a route handler
// (validating what a client sent) without caring which side it's on.
//
// partner and partnerConfig are a matched pair that Bags drops silently
// (only a toast on their side) if either is malformed — refuse to build the
// URL rather than open a launch flow that silently loses our attribution.
// feeMode is deliberately never set: Bags can silently drop every fee-sharing
// param when it's present.
export function buildBagsLaunchIntentUrl(params: BagsLaunchIntentParams): string {
  const { partner, partnerConfig } = params;
  if (!partner || !partnerConfig) {
    throw new BagsLaunchConfigError(
      "Bags partner pair (partner + partnerConfig) is missing"
    );
  }

  const name = params.name.trim().slice(0, MAX_NAME_LENGTH);
  // Bags tickers are alphanumeric only; strip anything else rather than
  // reject, since stray punctuation in a pasted caption is common and not
  // worth blocking a launch over.
  const ticker = params.ticker
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, MAX_TICKER_LENGTH);
  if (!name || !ticker) {
    throw new BagsLaunchConfigError("name and ticker are required");
  }

  const query = new URLSearchParams({ name, ticker, partner, partnerConfig });
  if (params.description) query.set("description", params.description);
  if (params.image) query.set("image", params.image);
  if (params.website) query.set("website", params.website);
  if (params.twitter) query.set("twitter", params.twitter);

  return `${LAUNCH_INTENT_BASE}&${query.toString()}`;
}

// Base58, no 0/O/I/l. Solana addresses are 32-44 chars in that alphabet.
// Deliberately loose (format only, not a real on-curve check) — it exists to
// reject obvious junk before spending a Bags API call, not to fully validate.
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isPlausibleSolanaAddress(value: string): boolean {
  return BASE58_ADDRESS_RE.test(value.trim());
}

/**
 * Buy creator tokens — invest in a creator.
 * Uses Bags bonding curve pricing.
 */
export async function buyCreatorToken(
  projectId: string,
  solAmount: number,
  buyerWallet: string
): Promise<BagsPurchaseResult> {
  // Production: POST /api/tokens/buy with signed Solana tx
  await delay(1800);
  const tokenAmount = Math.floor((solAmount / 0.042) * (0.9 + Math.random() * 0.2));
  const result: BagsPurchaseResult = {
    txSignature: `${Math.random().toString(36).slice(2, 30)}`,
    tokenAmount,
    solSpent: solAmount,
    newPrice: 0.042 * (1 + solAmount * 0.01),
  };
  return result;
}

/**
 * Sell creator tokens back via bonding curve.
 */
export async function sellCreatorToken(
  projectId: string,
  tokenAmount: number,
  sellerWallet: string
): Promise<{ txSignature: string; solReceived: number }> {
  await delay(1500);
  return {
    txSignature: `${Math.random().toString(36).slice(2, 30)}`,
    solReceived: parseFloat((tokenAmount * 0.038).toFixed(4)),
  };
}

/**
 * Fetch live token price from Bags.
 */
export async function getBagsTokenPrice(projectId: string): Promise<number> {
  await delay(300);
  return 0.042 + Math.random() * 0.005;
}

/** Format a Bags event into a human-readable toast message */
export function formatBagsEventMessage(event: BagsEvent): string {
  switch (event.type) {
    case "project_created":
      return `Your creator project was created on Bags (ID: ${event.projectId.slice(0, 12)}...)`;
    case "token_created":
      return `Your creator token $${event.symbol} is live on Bags!`;
    case "token_purchased":
      return `Investment made via Bags: ${event.tokenAmount.toLocaleString()} $${event.symbol} for ${event.sol} SOL`;
    case "token_sold":
      return `Sold via Bags: ${event.tokenAmount.toLocaleString()} $${event.symbol}`;
  }
}
