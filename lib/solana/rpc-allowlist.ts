// Kept out of app/api/rpc/route.ts so it can be tested directly: that route
// imports next/server and the "@/" alias, neither of which resolves under
// `node --test`. This allowlist is the security boundary of the proxy, so it
// gets tested rather than assumed.
//
// Restricted to the methods the tip and mint flows actually need — an
// unrestricted proxy would be scraped and used as a free general-purpose RPC
// on our quota. Deliberately excluded: getProgramAccounts,
// getSignaturesForAddress, getBlock* and the DAS endpoints.
//
// "sendTransaction" is the wire method behind connection.sendRawTransaction().
// The account/rent/simulate entries are what @metaplex-foundation/umi needs to
// build a mint; see lib/nft.ts.
//
// The Irys storage top-up (@irys/web-upload-solana) needs two more.
// getRecentPrioritizationFees sets the top-up's priority fee: refused, the SDK
// falls back to a fee of 0 and the tx can be dropped on mainnet. getTransaction
// is how it confirms the top-up landed: refused, it waits out a 30 s poll that
// can never succeed. The per-IP rpc rate limit still bounds both.
export const ALLOWED_RPC_METHODS = [
  // shared
  "getLatestBlockhash",
  "getBalance",
  "getFeeForMessage",
  "sendTransaction",
  "getSignatureStatuses",
  "getVersion",
  // mint (umi)
  "getAccountInfo",
  "getMultipleAccounts",
  "getMinimumBalanceForRentExemption",
  "simulateTransaction",
  "getSlot",
  "getBlockHeight",
  "getEpochInfo",
  // mint priority fee (lib/nft.ts) and Irys storage top-up
  "getRecentPrioritizationFees",
  "getTransaction",
] as const;

const ALLOWED = new Set<string>(ALLOWED_RPC_METHODS);

export function isAllowedRpcBody(body: unknown): boolean {
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0) return false;
  // A batch is rejected whole if any member is off-allowlist, so a disallowed
  // method can't ride along with a permitted one.
  return calls.every((call) => {
    const method = (call as { method?: unknown } | null)?.method;
    return typeof method === "string" && ALLOWED.has(method);
  });
}
