// Server-only Bags.fm integration (KAN-29). Never import this from a "use
// client" file: BAGS_API_KEY would end up in the browser bundle. The pure,
// client-safe pieces (URL builder, address validator) live in lib/bags.ts.
//
// Single live/mock switch for every Bags call site (KAN-29 follow-up,
// correction 1). Do not recompute this condition anywhere else — the client
// never derives it itself, it only reads the `live` field this module hands
// back through GET /api/bags/launch-config and POST /api/bags/verify.
import { SOLANA_ENABLED, SOLANA_NETWORK } from "./solana/network";
import { isPlausibleSolanaAddress } from "./bags";

// mainnet-requires-VERCEL_ENV=production is already enforced inside
// lib/solana/network.ts (it throws at import otherwise), so this can only
// ever be true in a real production deploy. Preview, local and CI always get
// devnet, so this is always false there.
export function isBagsLiveModeEnabled(): boolean {
  return SOLANA_ENABLED && SOLANA_NETWORK === "mainnet";
}

interface BagsSecrets {
  apiKey: string;
  partnerWallet: string;
  partnerConfig: string;
}

let cachedSecrets: BagsSecrets | null = null;

// Lazy on purpose (KAN-29 follow-up, correction 2): these three are only set
// in production. Reading them at import time broke Preview, where they are
// deliberately unset. Call this only from a path already gated on
// isBagsLiveModeEnabled() — never speculatively.
function getBagsSecrets(): BagsSecrets {
  if (cachedSecrets) return cachedSecrets;
  const apiKey = process.env.BAGS_API_KEY;
  if (!apiKey) throw new Error("Missing BAGS_API_KEY");
  const partnerWallet = process.env.BAGS_PARTNER_WALLET;
  if (!partnerWallet) throw new Error("Missing BAGS_PARTNER_WALLET");
  const partnerConfig = process.env.BAGS_PARTNER_CONFIG;
  if (!partnerConfig) throw new Error("Missing BAGS_PARTNER_CONFIG");
  cachedSecrets = { apiKey, partnerWallet, partnerConfig };
  return cachedSecrets;
}

// Exposed so GET /api/bags/launch-config can hand the client its two
// non-secret values (see lib/bags.ts buildBagsLaunchIntentUrl) without the
// route reading process.env itself.
export function getBagsPartnerPair(): { partnerWallet: string; partnerConfig: string } {
  const { partnerWallet, partnerConfig } = getBagsSecrets();
  return { partnerWallet, partnerConfig };
}

const BAGS_API_BASE = "https://public-api-v2.bags.fm/api/v1";

// Bags has no SLA on these endpoints. Fail the request rather than hang the
// route past Vercel's own function timeout.
const REQUEST_TIMEOUT_MS = 8000;

async function bagsGet(path: string): Promise<unknown> {
  const { apiKey } = getBagsSecrets();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BAGS_API_BASE}${path}`, {
      headers: { "x-api-key": apiKey },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Bags API ${path} returned ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Every field but accountKeys is optional on purpose: this is a narrow view
// of whatever Bags actually returns, not a claim that the full response looks
// like this. accountKeys is nullable per KAN-73.
export interface BagsTokenLaunch {
  accountKeys: string[] | null;
  status?: string;
  launchWallet?: string;
  creatorFeeBps?: number;
  dbcConfigKey?: string;
  dbcPoolKey?: string;
}

export interface BagsTokenCreator {
  wallet?: string;
  royaltyBps?: number;
  isCreator?: boolean;
  isAdmin?: boolean;
  provider?: string;
  providerUsername?: string;
}

function parseTokenLaunch(raw: unknown): BagsTokenLaunch {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const accountKeys = Array.isArray(obj.accountKeys)
    ? obj.accountKeys.filter((k): k is string => typeof k === "string")
    : null;
  return {
    accountKeys,
    status: typeof obj.status === "string" ? obj.status : undefined,
    launchWallet: typeof obj.launchWallet === "string" ? obj.launchWallet : undefined,
    creatorFeeBps: typeof obj.creatorFeeBps === "number" ? obj.creatorFeeBps : undefined,
    dbcConfigKey: typeof obj.dbcConfigKey === "string" ? obj.dbcConfigKey : undefined,
    dbcPoolKey: typeof obj.dbcPoolKey === "string" ? obj.dbcPoolKey : undefined,
  };
}

function parseTokenCreator(raw: unknown): BagsTokenCreator {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    wallet: typeof obj.wallet === "string" ? obj.wallet : undefined,
    royaltyBps: typeof obj.royaltyBps === "number" ? obj.royaltyBps : undefined,
    isCreator: typeof obj.isCreator === "boolean" ? obj.isCreator : undefined,
    isAdmin: typeof obj.isAdmin === "boolean" ? obj.isAdmin : undefined,
    provider: typeof obj.provider === "string" ? obj.provider : undefined,
    providerUsername: typeof obj.providerUsername === "string" ? obj.providerUsername : undefined,
  };
}

export async function getTokenLaunch(tokenMint: string): Promise<BagsTokenLaunch> {
  const raw = await bagsGet(`/token-launch?tokenMint=${encodeURIComponent(tokenMint)}`);
  return parseTokenLaunch(raw);
}

export async function getTokenCreators(tokenMint: string): Promise<BagsTokenCreator[]> {
  const raw = await bagsGet(`/token-launch/creator/v3?tokenMint=${encodeURIComponent(tokenMint)}`);
  return Array.isArray(raw) ? raw.map(parseTokenCreator) : [];
}

// Attribution check per KAN-73: the partner wallet address itself shows up in
// accountKeys when a launch carries our partner pair. The Partner Config PDA
// never appears there, so it is deliberately not part of this check.
export function isPartnerAttributed(launch: BagsTokenLaunch): boolean {
  const { partnerWallet } = getBagsSecrets();
  return launch.accountKeys?.includes(partnerWallet) ?? false;
}

// Exact match on purpose: Solana addresses are base58 and case-sensitive, so
// there is no meaningful "close enough" here.
export function isCallerVerifiedCreator(creators: BagsTokenCreator[], wallet: string): boolean {
  return creators.some((c) => c.wallet === wallet && c.isCreator === true);
}

export interface VerifyLaunchInput {
  callerWallet?: string;
  tokenMint?: string;
  name: string;
  symbol: string;
}

export interface VerifyLaunchSuccess {
  simulated: boolean;
  tokenMint: string;
  partnerAttributed: boolean;
}

// Thrown instead of returning a { ok: false, ... } union member: this
// tsconfig runs with `strict: false` (project-wide, not something to change
// for this ticket), under which discriminated-union narrowing on an async
// function's return value does not reliably hold at the call site. A thrown,
// typed error sidesteps that rather than fighting it.
export class BagsVerifyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// All the live-vs-mock branching for a claimed launch lives here, in the one
// place every caller (the verify route) goes through. Off mainnet this never
// touches public-api-v2.bags.fm and never reads a Bags secret (correction 2).
export async function verifyBagsLaunch(input: VerifyLaunchInput): Promise<VerifyLaunchSuccess> {
  if (!isBagsLiveModeEnabled()) {
    // Obviously fake and stable per symbol, not random, so it's recognizable
    // wherever it's displayed (claim card, creator profile) as Preview-only.
    return {
      simulated: true,
      tokenMint: `SIMULATED_${input.symbol}`,
      partnerAttributed: true,
    };
  }

  if (!input.tokenMint || !isPlausibleSolanaAddress(input.tokenMint)) {
    throw new BagsVerifyError(400, "tokenMint is not a valid Solana address");
  }
  if (!input.callerWallet) {
    throw new BagsVerifyError(400, "Link a wallet to your account before verifying a Bags launch");
  }

  // Read outside the try/catch below on purpose: a missing env var is a
  // config problem, not a Bags outage, and must not come out looking like
  // "Failed to reach Bags" (correction 2 — throw naming the missing var).
  getBagsSecrets();

  let creators: BagsTokenCreator[];
  try {
    creators = await getTokenCreators(input.tokenMint);
  } catch {
    throw new BagsVerifyError(502, "Failed to reach Bags");
  }
  if (!isCallerVerifiedCreator(creators, input.callerWallet)) {
    throw new BagsVerifyError(403, "This wallet is not recorded as the creator of this token on Bags");
  }

  let launch: BagsTokenLaunch;
  try {
    launch = await getTokenLaunch(input.tokenMint);
  } catch {
    throw new BagsVerifyError(502, "Failed to reach Bags");
  }

  // A launch not attributed to our partner link is not an error the user
  // caused — the route still stores it, just flagged, so we can see how
  // often creators bypass our link.
  return {
    simulated: false,
    tokenMint: input.tokenMint,
    partnerAttributed: isPartnerAttributed(launch),
  };
}
