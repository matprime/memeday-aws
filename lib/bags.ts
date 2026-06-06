"use client";

/**
 * Bags SDK Integration
 * Bags is a Solana-native creator economy platform.
 * Each creator gets a Project + fungible Creator Token.
 *
 * In production: replace simulated calls with the real Bags SDK.
 * Endpoint: https://bags.fm/api  (or use npm i @bags/sdk when available)
 */

import { BagsEvent } from "./types";

const BAGS_API_BASE = "https://bags.fm/api";

// Simulated delay to mimic real network calls
const delay = (ms: number) =>
  new Promise<void>((res) => setTimeout(res, ms));

/** Generates a pseudo project ID for demo purposes */
const genProjectId = (wallet: string) =>
  `bags-${wallet.slice(0, 6)}-${Math.random().toString(36).slice(2, 8)}`;

export interface BagsProject {
  projectId: string;
  walletAddress: string;
  name: string;
  createdAt: string;
}

export interface BagsToken {
  symbol: string;
  name: string;
  projectId: string;
  mintAddress: string;
  initialPrice: number;
}

export interface BagsPurchaseResult {
  txSignature: string;
  tokenAmount: number;
  solSpent: number;
  newPrice: number;
}

/**
 * Create a Bags project for a creator.
 * One project per wallet — idempotent.
 */
export async function createBagsProject(
  walletAddress: string,
  creatorName: string
): Promise<BagsProject> {
  // Production: POST /api/projects with signed transaction
  await delay(1200);
  const project: BagsProject = {
    projectId: genProjectId(walletAddress),
    walletAddress,
    name: creatorName,
    createdAt: new Date().toISOString(),
  };
  return project;
}

/**
 * Create a fungible creator token inside a Bags project.
 * Launches a bonding-curve token on Solana.
 */
export async function createBagsToken(
  projectId: string,
  name: string,
  symbol: string,
  _imageUrl?: string
): Promise<BagsToken> {
  // Production: POST /api/tokens with token metadata
  await delay(1500);
  const token: BagsToken = {
    symbol: symbol.toUpperCase().slice(0, 6),
    name,
    projectId,
    mintAddress: `${symbol.toLowerCase()}mint${Math.random()
      .toString(36)
      .slice(2, 10)}`,
    initialPrice: 0.001,
  };
  return token;
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
