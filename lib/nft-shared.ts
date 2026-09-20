// Pure helpers for the client mint flow, kept free of imports so they can be
// tested directly: lib/nft.ts pulls in umi and the wallet adapter, neither of
// which loads under `node --test`.

// Same content-type guess used whether the image is a DynamoDB row's stored
// url or a freshly uploaded Arweave one. Known gap, not fixed here: an
// extensionless url (Arweave gateway links have none) falls through to
// image/jpeg even for a PNG.
export function imageMimeFromUrl(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

export interface NftMetadataDoc {
  name: string;
  symbol: string;
  description: string;
  image: string;
  properties: {
    files: { uri: string; type: string }[];
    category: string;
  };
}

// The one shape both storage modes emit: GET /api/nft-metadata/[id] for s3
// (reading a stored row) and the client's direct Irys upload for irys
// (nothing stored). Existing s3 rows must keep reading back exactly as they
// did before this function existed.
export function buildNftMetadataDoc(params: {
  name: string;
  description: string;
  image: string;
}): NftMetadataDoc {
  return {
    name: params.name,
    symbol: "MDAY",
    description: params.description,
    image: params.image,
    properties: {
      files: [{ uri: params.image, type: imageMimeFromUrl(params.image) }],
      category: "image",
    },
  };
}

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
export function checkUri(uri: unknown, label: string): string {
  // Typed unknown rather than string because the callers feed it a value from
  // outside: an uploader that returns nothing for a cancelled payment handed
  // this `undefined`, and the mint died on "Cannot read properties of
  // undefined" instead of naming the step that failed.
  if (typeof uri !== "string" || !uri) {
    throw new Error(`${label} is missing — the upload did not return one`);
  }
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
  // Closing the wallet popup is a decline that never says so: Phantom reports
  // it as "Plugin Closed" with no code. Left unmatched, the request was never
  // parked as retryable and the user could not mint that meme again.
  return /user (rejected|declined)|request rejected|plugin closed|user closed|popup closed/i.test(
    e.message ?? ""
  );
}
