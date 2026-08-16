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
// Server-only. A paid provider endpoint carries its API key in the URL, and
// anything handed to a client component ships in the page the browser
// downloads — so this value must never be passed down the React tree. It is
// read by app/api/rpc/route.ts and nothing else.
export const SOLANA_RPC_URL = rawRpcUrl;

// What the browser gets instead: our own proxy route. Kept as a path rather
// than an absolute URL because the correct origin differs per environment
// (localhost, a per-deployment preview host, a custom production domain), and
// guessing it from VERCEL_URL would point custom-domain traffic at a different
// origin and break same-origin fetches. components/WalletProvider.tsx resolves
// it against window.location.origin, which is right everywhere by definition.
export const SOLANA_CLIENT_RPC_PATH = "/api/rpc";

// Guard against a network/endpoint mismatch. SOLANA_NETWORK drives the UI, the
// explorer links and the mainnet-requires-production check above, but nothing
// tied it to the endpoint actually being called — so SOLANA_NETWORK=devnet
// paired with a mainnet SOLANA_RPC_URL would move real SOL while every label in
// the app said devnet. One mis-scoped Vercel variable was enough.
//
// Provider hostnames encode the cluster (QuickNode .solana-mainnet./.solana-devnet.,
// Helius mainnet./devnet.helius-rpc.com, public api.mainnet-beta./api.devnet.),
// so the realistic mistake is cheap to catch. A custom hostname naming neither
// is allowed through: this can only catch what the URL actually declares.
const rpcUrlLower = rawRpcUrl.toLowerCase();
const urlSaysMainnet = rpcUrlLower.includes("mainnet");
const urlSaysNonMainnet =
  rpcUrlLower.includes("devnet") || rpcUrlLower.includes("testnet");

if (SOLANA_NETWORK === "devnet" && urlSaysMainnet && !urlSaysNonMainnet) {
  throw new Error(
    "SOLANA_NETWORK=devnet but SOLANA_RPC_URL points at mainnet. " +
      "This would spend real SOL while the app reports devnet. " +
      "Set a devnet endpoint, or set SOLANA_NETWORK=mainnet deliberately."
  );
}

if (SOLANA_NETWORK === "mainnet" && urlSaysNonMainnet && !urlSaysMainnet) {
  throw new Error(
    "SOLANA_NETWORK=mainnet but SOLANA_RPC_URL points at devnet/testnet. " +
      "Real-money transactions would be sent to a test cluster. " +
      "Set the mainnet endpoint for this environment."
  );
}

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
