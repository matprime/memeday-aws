// Kept out of app/api/rpc/route.ts so it can be tested directly: that route
// imports next/server and the "@/" alias, neither of which resolves under
// `node --test`. This allowlist is the security boundary of the proxy, so it
// gets tested rather than assumed.
//
// Restricted to the methods the tip and mint flows actually need — an
// unrestricted proxy would be scraped and used as a free general-purpose RPC
// on our quota. Deliberately excluded: getProgramAccounts,
// getSignaturesForAddress, getBlock*, getTransaction and the DAS endpoints.
//
// "sendTransaction" is the wire method behind connection.sendRawTransaction().
// The account/rent/simulate entries are what @metaplex-foundation/umi needs to
// build a mint; see lib/nft.ts.
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
