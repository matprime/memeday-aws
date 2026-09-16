// Server-only Bags.fm integration (KAN-29). Never import this from a "use
// client" file: BAGS_API_KEY would end up in the browser bundle. The pure,
// client-safe pieces (URL builder, address validator) live in lib/bags.ts.
//
// Single live/mock switch for every Bags call site (KAN-29 follow-up,
// correction 1). Do not recompute this condition anywhere else — the client
// never derives it itself, it only reads the `live` field this module hands
// back through GET /api/bags/launch-config and POST /api/bags/verify.
import { Connection, PublicKey } from "@solana/web3.js";
import { SOLANA_ENABLED, SOLANA_NETWORK, SOLANA_RPC_URL } from "./solana/network";
import { SOLANA_COMMITMENT } from "./nft-config";
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

// Every field is optional on purpose: this is a narrow view of whatever Bags
// actually returns, not a claim that the full response looks like this.
export interface BagsTokenLaunch {
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
  // Same envelope as getTokenCreators below: Bags wraps every response as
  // { success, response }, confirmed against the live API during the
  // KAN-79 creator-mismatch investigation. Before that fix, every field
  // below silently read as undefined off the wrong object.
  const obj = ((raw as { response?: unknown })?.response ?? {}) as Record<string, unknown>;
  return {
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
  // Bags wraps every response as { success, response }, not a bare array or
  // object (confirmed against the live API during the KAN-79 creator-mismatch
  // investigation). Unwrap that envelope before checking shape.
  const list = (raw as { response?: unknown })?.response;
  return Array.isArray(list) ? list.map(parseTokenCreator) : [];
}

export type PartnerAttribution = "attributed" | "not_attributed" | "unknown";

// KAN-29 follow-up: the launch transaction's accountKeys is not a valid
// attribution signal (that's what KAN-73 got wrong — the only reason it ever
// read true is that its one test launch was made from the partner wallet
// itself, which put it in accountKeys as the creator; every real creator
// launch reads false regardless of the truth). Bags stores the partner in a
// separate on-chain account, FeeShareConfig (fee-share-v2 program), created
// in its own transaction before the launch and never referenced by it. This
// reads that account directly instead.
const FEE_SHARE_V2_PROGRAM_ID = "FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

// The discriminator Anchor put on the deployed accounts (FeeShareConfigHeader),
// plus the one Anchor derives for the full struct name (FeeShareConfig).
// Anything else is not this account type.
const FEE_SHARE_CONFIG_DISCRIMINATORS = [
  [40, 71, 136, 156, 222, 49, 31, 201],
  [240, 232, 7, 22, 50, 198, 71, 210],
];

function matchesFeeShareConfigDiscriminator(data: Buffer): boolean {
  return FEE_SHARE_CONFIG_DISCRIMINATORS.some((disc) =>
    disc.every((byte, i) => data[i] === byte)
  );
}

// Reads the FeeShareConfig PDA for a launch and checks whether it names our
// partner pair. Never throws: a Solana RPC hiccup here must not block a
// creator binding their own token, so every failure mode (account missing,
// wrong owner or discriminator, RPC error, timeout) collapses to "unknown"
// rather than surfacing as a 502.
export async function getPartnerAttribution(tokenMint: string): Promise<PartnerAttribution> {
  const { partnerWallet, partnerConfig } = getBagsSecrets();
  const programId = new PublicKey(FEE_SHARE_V2_PROGRAM_ID);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("fee_share_config"),
        new PublicKey(tokenMint).toBuffer(),
        new PublicKey(WRAPPED_SOL_MINT).toBuffer(),
      ],
      programId
    );

    const connection = new Connection(SOLANA_RPC_URL, SOLANA_COMMITMENT);
    const account = await Promise.race([
      connection.getAccountInfo(pda),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("FeeShareConfig read timed out")), REQUEST_TIMEOUT_MS);
      }),
    ]);

    if (!account) return "unknown";
    if (!account.owner.equals(programId)) return "unknown";
    if (!matchesFeeShareConfigDiscriminator(account.data)) return "unknown";

    const partner = new PublicKey(account.data.subarray(72, 104)).toBase58();
    const partnerConfigOnChain = new PublicKey(account.data.subarray(104, 136)).toBase58();
    return partner === partnerWallet && partnerConfigOnChain === partnerConfig
      ? "attributed"
      : "not_attributed";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
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
  partnerAttribution: PartnerAttribution;
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
      partnerAttribution: "attributed",
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

  // A launch not attributed to our partner link (or one we couldn't read the
  // on-chain state for) is not an error the user caused — the route still
  // stores it, just flagged, so we can see how often creators bypass our
  // link or hit an RPC hiccup.
  return {
    simulated: false,
    tokenMint: input.tokenMint,
    partnerAttribution: await getPartnerAttribution(input.tokenMint),
  };
}
