// Single choke point for NFT minting config, same pattern as
// lib/solana/network.ts: validate at import time and fail loudly rather than
// letting a typo surface as a wrong royalty or a cleanup job that never runs.
//
// Unlike SOLANA_*, these all have defaults. They describe minting policy
// rather than which chain we are on, so an existing deployment that has not
// set them keeps the behaviour it already had — but an invalid value is still
// a hard error, never a silent fallback.

export type SolanaCommitment = "processed" | "confirmed" | "finalized";
export type NftStorageProvider = "s3" | "irys";

const rawCommitment = process.env.SOLANA_COMMITMENT ?? "confirmed";
if (
  rawCommitment !== "processed" &&
  rawCommitment !== "confirmed" &&
  rawCommitment !== "finalized"
) {
  throw new Error(
    `Invalid SOLANA_COMMITMENT: "${rawCommitment}". Must be "processed", "confirmed" or "finalized".`
  );
}
// "confirmed" matches what the existing mint and tip paths already wait for
// (lib/nft.ts, lib/solana/confirm.ts). "processed" is deliberately allowed but
// is not safe to mark a mint CONFIRMED on — that decision lives in the
// verifier, not here.
export const SOLANA_COMMITMENT: SolanaCommitment = rawCommitment;

const rawProvider = process.env.NFT_STORAGE_PROVIDER ?? "s3";
if (rawProvider !== "s3" && rawProvider !== "irys") {
  throw new Error(
    `Invalid NFT_STORAGE_PROVIDER: "${rawProvider}". Must be "s3" or "irys".`
  );
}
// "s3" is the pre-existing behaviour: image on CloudFront, metadata JSON
// served from DynamoDB by /api/nft-metadata/[id]. "irys" uploads both to
// Arweave, paid by the connected wallet. Defaults to "s3" so nothing changes
// for a deployment that has not opted in.
export const NFT_STORAGE_PROVIDER: NftStorageProvider = rawProvider;

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  // Number() would accept "1e3", " 12 " and "0x10"; require plain digits so a
  // malformed value is rejected instead of quietly meaning something else.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${name}: "${raw}". Must be a whole number.`);
  }
  return Number(raw);
}

const royaltyBps = positiveInt(
  "NFT_SECONDARY_SALE_ROYALTY_BASIS_POINTS",
  process.env.NFT_SECONDARY_SALE_ROYALTY_BASIS_POINTS,
  250
);
if (royaltyBps > 10000) {
  throw new Error(
    `Invalid NFT_SECONDARY_SALE_ROYALTY_BASIS_POINTS: ${royaltyBps}. Must be 0-10000 (10000 = 100%).`
  );
}
// Was hardcoded at the mpl-core Royalties plugin call site. The server-side
// verifier re-reads this to check the on-chain plugin matches, so the two can
// never drift apart.
export const NFT_ROYALTY_BASIS_POINTS = royaltyBps;

const retentionHours = positiveInt(
  "NFT_ORPHANED_UPLOAD_RETENTION_HOURS",
  process.env.NFT_ORPHANED_UPLOAD_RETENTION_HOURS,
  24
);
if (retentionHours === 0) {
  throw new Error(
    "Invalid NFT_ORPHANED_UPLOAD_RETENTION_HOURS: 0. A zero retention would " +
      "expire a mint request while the user is still signing it."
  );
}
export const NFT_ORPHANED_UPLOAD_RETENTION_HOURS = retentionHours;
export const NFT_ORPHANED_UPLOAD_RETENTION_SECONDS = retentionHours * 60 * 60;

// How long a prepared mint request stays signable before the client must call
// /api/mint/prepare again. Bounds replay of a captured prepare response, and
// is deliberately shorter than a Solana blockhash lifetime (~60-90s) so an
// expired nonce is caught by us with a clear error rather than by the RPC as
// an opaque "blockhash not found".
export const MINT_NONCE_TTL_SECONDS = 60;
