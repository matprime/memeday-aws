// Server-side proof that a mint actually happened, and happened the way we
// asked for it. SERVER ONLY.
//
// Why this file exists: the mint transaction is built and signed in the
// browser, so everything the client tells us afterwards ("here is my mint
// address") is a claim, not a fact. Before this, app/api/memes wrote whatever
// nftMint the browser sent, which meant any authenticated user could claim any
// address, or a fabricated one. Nothing may reach status CONFIRMED on a
// client's say-so — only on what the chain reports.
//
// It talks to SOLANA_RPC_URL directly. The allowlist in lib/solana/rpc-allowlist.ts
// guards the browser-facing proxy and deliberately does not apply here.

import { Connection, PublicKey } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplCore, safeFetchAssetV1 } from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
import { SOLANA_RPC_URL } from "./network";
import { NFT_ROYALTY_BASIS_POINTS, SOLANA_COMMITMENT } from "../nft-config";

// Coded reasons rather than free text. These are safe to return to the client:
// they say what failed without echoing RPC, wallet or gateway error strings,
// which is where provider URLs and API keys leak from.
export type MintVerificationFailure =
  | "ASSET_NOT_FOUND"
  | "OWNER_MISMATCH"
  | "URI_MISMATCH"
  | "NAME_MISMATCH"
  | "ROYALTY_MISMATCH"
  | "METADATA_UNREACHABLE"
  // Split out from METADATA_UNREACHABLE so a failure says which of the three
  // very different problems it was: the document is not there, the host could
  // not be reached at all, or what came back was not a JSON document.
  | "METADATA_NOT_FOUND"
  | "METADATA_NOT_JSON"
  | "METADATA_IMAGE_MISMATCH"
  | "TRANSACTION_NOT_FOUND"
  | "TRANSACTION_FAILED"
  | "FEE_PAYER_MISMATCH"
  | "RPC_UNAVAILABLE";

// A string discriminant rather than a boolean one: this project compiles with
// "strict": false, and without strictNullChecks TypeScript will not narrow a
// union on a boolean field, so `if (!result.ok)` would leave `reason`
// unreachable at the call site.
export type MintVerificationResult =
  | { outcome: "verified"; mintAddress: string }
  | { outcome: "rejected"; reason: MintVerificationFailure };

export function isValidSolanaAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try {
    // Constructing a PublicKey is the only check that actually rejects a
    // base58 string of the wrong decoded length.
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function serverUmi() {
  return createUmi(SOLANA_RPC_URL).use(mplCore());
}

export interface VerifyMintInput {
  // Recorded before the user signed, which is what lets us verify — and
  // reconcile — without needing the transaction signature.
  assetAddress: string;
  ownerWallet: string;
  metadataUri: string;
  expectedName: string;
  // The image URI we recorded. Checked against what the metadata document
  // actually points at, so a client cannot upload a document describing some
  // other image and have us bless it.
  expectedImageUri: string;
}

// Reads the asset account and checks every parameter we care about against
// what we asked for. Absence is reported as ASSET_NOT_FOUND rather than thrown:
// "the mint has not landed (yet)" is a normal answer here, and the caller
// decides whether that means keep waiting or give up.
export async function verifyAssetOnChain(
  input: VerifyMintInput
): Promise<MintVerificationResult> {
  let asset;
  try {
    asset = await safeFetchAssetV1(serverUmi(), publicKey(input.assetAddress), {
      commitment: SOLANA_COMMITMENT,
    });
  } catch {
    // Network/provider problem, not a verdict about the asset. Distinguished
    // so a flaky RPC never gets recorded as a failed mint.
    return { outcome: "rejected", reason: "RPC_UNAVAILABLE" };
  }

  if (!asset) return { outcome: "rejected", reason: "ASSET_NOT_FOUND" };

  if (asset.owner.toString() !== input.ownerWallet) {
    return { outcome: "rejected", reason: "OWNER_MISMATCH" };
  }
  if (asset.uri !== input.metadataUri) {
    return { outcome: "rejected", reason: "URI_MISMATCH" };
  }
  if (asset.name !== input.expectedName) {
    return { outcome: "rejected", reason: "NAME_MISMATCH" };
  }

  const bps = asset.royalties?.basisPoints;
  // basisPoints is a bigint-ish numeric from the deserializer; compare as
  // Number after an explicit presence check so a missing plugin is not read
  // as 0 and silently accepted when we configured a non-zero royalty.
  if (bps === undefined || Number(bps) !== NFT_ROYALTY_BASIS_POINTS) {
    return { outcome: "rejected", reason: "ROYALTY_MISMATCH" };
  }

  return { outcome: "verified", mintAddress: input.assetAddress };
}

// The on-chain uri is just a string; it proves nothing about what that
// document says. Fetching it is what stops a client uploading metadata that
// points at an entirely different image from the one we validated and stored.
// One retry, because this runs seconds after the document is published and a
// just-written document is the normal case here, not an edge case: a CDN or an
// Arweave gateway that has not caught up yet is a wait, not a verdict. Anything
// still unreadable after it is treated as unreadable.
async function fetchMetadata(
  metadataUri: string
): Promise<{ doc: unknown } | { failure: MintVerificationFailure }> {
  let failure: MintVerificationFailure = "METADATA_UNREACHABLE";
  // Three tries with a growing gap. The document may be served by a different
  // deployment than the one that wrote it, so "not there yet" can outlast a
  // single one-second wait, and every attempt here is cheaper than a mint that
  // has to be refused.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    let res: Response;
    try {
      res = await fetch(metadataUri, {
        // A gateway that hangs must not hold a serverless invocation open.
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
    } catch {
      failure = "METADATA_UNREACHABLE";
      continue;
    }
    if (!res.ok) {
      failure = res.status === 404 ? "METADATA_NOT_FOUND" : "METADATA_UNREACHABLE";
      continue;
    }
    try {
      return { doc: await res.json() };
    } catch {
      // An SSO interstitial or an error page: reachable, but not a document.
      failure = "METADATA_NOT_JSON";
      continue;
    }
  }
  return { failure };
}

export async function verifyMetadataDocument(
  metadataUri: string,
  expectedImageUri: string
): Promise<MintVerificationResult | null> {
  const fetched = await fetchMetadata(metadataUri);
  if ("failure" in fetched) {
    return { outcome: "rejected", reason: fetched.failure };
  }
  const doc = fetched.doc;

  const image = (doc as { image?: unknown })?.image;
  if (typeof image !== "string" || image !== expectedImageUri) {
    return { outcome: "rejected", reason: "METADATA_IMAGE_MISMATCH" };
  }
  return null; // null == no objection
}

// Optional corroboration. The asset account is the authority on whether the
// mint exists; this adds "and the user paid for it", which is the part of the
// fee model we would otherwise be taking on trust.
export async function verifyTransaction(
  signature: string,
  ownerWallet: string
): Promise<MintVerificationResult | null> {
  const connection = new Connection(SOLANA_RPC_URL, SOLANA_COMMITMENT);
  let tx;
  try {
    tx = await connection.getTransaction(signature, {
      commitment: SOLANA_COMMITMENT === "processed" ? "confirmed" : SOLANA_COMMITMENT,
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    return { outcome: "rejected", reason: "RPC_UNAVAILABLE" };
  }

  if (!tx) return { outcome: "rejected", reason: "TRANSACTION_NOT_FOUND" };
  if (tx.meta?.err) return { outcome: "rejected", reason: "TRANSACTION_FAILED" };

  // Index 0 of the static account keys is the fee payer by definition.
  const feePayer = tx.transaction.message.getAccountKeys().get(0)?.toBase58();
  if (feePayer !== ownerWallet) {
    return { outcome: "rejected", reason: "FEE_PAYER_MISMATCH" };
  }
  return null;
}

// The full gate. Every check must pass before a request may become CONFIRMED.
// `signature` is optional because reconciliation runs without one: the asset
// account alone is enough to establish that the NFT exists and is ours.
export async function verifyMint(
  input: VerifyMintInput,
  signature?: string
): Promise<MintVerificationResult> {
  const assetResult = await verifyAssetOnChain(input);
  if (assetResult.outcome === "rejected") return assetResult;

  const metadataObjection = await verifyMetadataDocument(
    input.metadataUri,
    input.expectedImageUri
  );
  if (metadataObjection) return metadataObjection;

  if (signature) {
    const txObjection = await verifyTransaction(signature, input.ownerWallet);
    if (txObjection) return txObjection;
  }

  return assetResult;
}
