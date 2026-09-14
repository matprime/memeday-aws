// Pure helpers for the client mint flow, kept free of imports so they can be
// tested directly: lib/nft.ts pulls in umi and the wallet adapter, neither of
// which loads under `node --test`.

// mpl-core stores the metadata uri inline in the asset account. Same value as
// MAX_ON_CHAIN_URI_LEN in lib/nft-config.ts, duplicated rather than imported
// because that module reads server env at import time.
export const MAX_ON_CHAIN_URI_LEN = 200;

// Must match onChainName in lib/mint-service.ts exactly — the verifier compares
// the on-chain name against the server's copy of it, so a difference of one
// character is a NAME_MISMATCH on a mint the user has already paid for.
export function onChainName(caption: string): string {
  return caption.slice(0, 32);
}

// Checked here before the transaction is built as well as server-side before
// the uri is recorded, so an unusable uri cannot reach the chain.
export function checkUri(uri: string, label: string): string {
  if (!uri.startsWith("https://")) {
    throw new Error(`${label} must be an https URI`);
  }
  if (uri.length > MAX_ON_CHAIN_URI_LEN) {
    throw new Error(`${label} is too long (${uri.length} chars, max ${MAX_ON_CHAIN_URI_LEN})`);
  }
  // Checked here as well as server-side because this one is worth catching
  // before the user pays: the uri goes into an ImmutableMetadata asset, so an
  // unresolvable host is a permanently broken NFT, not a retryable error.
  let host: string;
  try {
    host = new URL(uri).hostname;
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    throw new Error(`${label} points at "${host}", which is not a resolvable domain`);
  }
  return uri;
}

// Wallet adapters do not agree on how a decline surfaces: Phantom throws a
// WalletSignTransactionError wrapping an EIP-1193-style 4001, others only set
// the message. All three are checked because the two outcomes are handled
// differently — a decline parks the request as retryable, anything else is a
// failure the user cannot fix by signing again.
export function isUserRejection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    name?: string;
    message?: string;
    code?: unknown;
    error?: { code?: unknown };
  };
  if (e.name === "WalletSignTransactionError") return true;
  if (e.code === 4001 || e.error?.code === 4001) return true;
  return /user (rejected|declined)|request rejected/i.test(e.message ?? "");
}
