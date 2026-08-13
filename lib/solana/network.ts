// Single choke point for Solana network config. Every RPC/mint/tip/wallet
// code path imports network name, RPC URL, explorer cluster, and the kill
// switch from here — never read SOLANA_* or hardcode a cluster/endpoint
// elsewhere. Fails loudly at import time, same pattern as lib/dynamo.ts.

export type SolanaNetwork = "devnet" | "mainnet";
export type SolanaExplorerCluster = "devnet" | "mainnet-beta";

const rawNetwork = process.env.SOLANA_NETWORK;
if (rawNetwork !== "devnet" && rawNetwork !== "mainnet") {
  throw new Error(
    `Invalid or missing SOLANA_NETWORK: "${rawNetwork}". Must be "devnet" or "mainnet".`
  );
}

// mainnet is only allowed on Vercel Production. Every other VERCEL_ENV value
// (preview, development, or unset for local/CI) rejects a mainnet request
// outright rather than silently downgrading it — fix the env config instead.
if (rawNetwork === "mainnet" && process.env.VERCEL_ENV !== "production") {
  throw new Error(
    `SOLANA_NETWORK=mainnet requires VERCEL_ENV=production (got "${process.env.VERCEL_ENV ?? "undefined"}"). ` +
      `Set SOLANA_NETWORK=devnet for this environment.`
  );
}

export const SOLANA_NETWORK: SolanaNetwork = rawNetwork;

const rawRpcUrl = process.env.SOLANA_RPC_URL;
if (!rawRpcUrl) {
  throw new Error("Missing SOLANA_RPC_URL");
}
export const SOLANA_RPC_URL = rawRpcUrl;

// Solana's own cluster identifiers ("mainnet-beta") differ from our app-level
// network name ("mainnet") — explorer links and clusterApiUrl() need this form.
export const SOLANA_EXPLORER_CLUSTER: SolanaExplorerCluster =
  SOLANA_NETWORK === "mainnet" ? "mainnet-beta" : "devnet";

const rawEnabled = process.env.SOLANA_ENABLED;
if (rawEnabled !== "true" && rawEnabled !== "false") {
  throw new Error(
    `Invalid or missing SOLANA_ENABLED: "${rawEnabled}". Must be "true" or "false".`
  );
}
export const SOLANA_ENABLED = rawEnabled === "true";

// Explicit, checkable disabled state — calling code short-circuits on this
// rather than the on-chain action silently no-oping.
export const SOLANA_DISABLED_MESSAGE =
  "On-chain features are temporarily disabled. Please check back soon.";
