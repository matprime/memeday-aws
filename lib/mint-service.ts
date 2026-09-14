// Shared guards for the /api/mint/* routes. SERVER ONLY.
//
// Every one of these routes has to answer the same questions before it does
// anything: is this a real user, is on-chain enabled, does the asset exist and
// belong to them, is the wallet theirs, and is the request they are pointing
// at still live. Keeping that in one place is what stops one route drifting
// into a weaker check than its neighbours.

import { getMemeById, getPendingUpload, getUserById } from "./db";
import type { DbMintRequest } from "./types";
import { MINT_NONCE_TTL_SECONDS } from "./nft-config";
import { randomUUID } from "crypto";

export interface ResolvedAsset {
  // "pending" = mint at post time, before the meme row exists.
  // "meme" = mint an already-posted meme.
  // Both use the same id: finalizeMeme reuses the pending upload id as the
  // meme id, so one assetId covers the asset's whole life.
  kind: "pending" | "meme";
  caption: string;
  imageUrl: string;
  alreadyMinted: boolean;
}

export type AssetProblem =
  | "ASSET_NOT_FOUND"
  | "ASSET_NOT_OWNED"
  | "ASSET_NOT_VALIDATED"
  | "ASSET_REJECTED"
  | "ALREADY_MINTED";

// The on-chain name is truncated at 32 characters by the mpl-core create call.
// The verifier compares against exactly this, so both sides must derive it the
// same way — hence one function rather than two .slice(0, 32) calls.
export function onChainName(caption: string): string {
  return caption.slice(0, 32);
}

export async function resolveAsset(
  assetId: string,
  userId: string
): Promise<{ asset: ResolvedAsset } | { problem: AssetProblem }> {
  const meme = await getMemeById(assetId);
  if (meme) {
    if (meme.creatorId !== userId && meme.ownerId !== userId) {
      return { problem: "ASSET_NOT_OWNED" };
    }
    if (meme.nftMint) return { problem: "ALREADY_MINTED" };
    return {
      asset: {
        kind: "meme",
        caption: meme.caption,
        imageUrl: meme.imageUrl,
        alreadyMinted: false,
      },
    };
  }

  const pending = await getPendingUpload(assetId);
  if (!pending) return { problem: "ASSET_NOT_FOUND" };
  if (pending.creatorId !== userId) return { problem: "ASSET_NOT_OWNED" };
  if (pending.status === "rejected") return { problem: "ASSET_REJECTED" };
  // Only an upload the validation Lambda has already cleared may be minted —
  // the same gate app/api/memes applies before a pending row becomes a meme.
  // Without it we would pin an unscreened image to Arweave permanently.
  if (pending.status !== "active") return { problem: "ASSET_NOT_VALIDATED" };

  const cfDomain = process.env.CLOUDFRONT_DOMAIN;
  return {
    asset: {
      kind: "pending",
      caption: pending.caption,
      imageUrl: cfDomain
        ? `https://${cfDomain}/${pending.s3Key}`
        : `/api/image/${pending.s3Key}`,
      alreadyMinted: false,
    },
  };
}

// The wallet is not something the client gets to assert. It must be the one
// already linked to this Cognito user, which is what stops a caller preparing
// a mint that pays from, and delivers to, somebody else's address.
export async function assertWalletBelongsToUser(
  userId: string,
  ownerWallet: string
): Promise<boolean> {
  const user = await getUserById(userId);
  return user?.walletAddr === ownerWallet;
}

export function newNonce(): { nonce: string; nonceExpiresAt: number } {
  return {
    nonce: randomUUID(),
    nonceExpiresAt: Math.floor(Date.now() / 1000) + MINT_NONCE_TTL_SECONDS,
  };
}

// Bounds replay of a captured prepare response. A stale or wrong nonce is
// rejected before any state moves.
export function nonceIsValid(request: DbMintRequest, nonce: unknown): boolean {
  if (typeof nonce !== "string" || !request.nonce) return false;
  if (request.nonce !== nonce) return false;
  if (!request.nonceExpiresAt) return false;
  return request.nonceExpiresAt > Math.floor(Date.now() / 1000);
}

// Anything a provider hands us may carry an endpoint URL with an API key in
// it, so nothing from an RPC, wallet or gateway is ever forwarded verbatim.
export function sanitizeError(err: unknown): string {
  if (err instanceof Error && err.name === "MintTransitionError") {
    return "The mint request is no longer in a state where that step is valid.";
  }
  return "The minting service could not complete that step. Please try again.";
}

// The wire shape for every /api/mint/* response. Fields that only make sense
// in some states are omitted rather than sent as null, so a client cannot mis-
// read an absent mint address as a present-but-empty one.
export function toMintResponse(request: DbMintRequest) {
  const body: Record<string, unknown> = {
    assetId: request.assetId,
    mintRequestId: request.mintRequestId,
    status: request.status,
    network: request.network,
    ownerWallet: request.ownerWallet,
  };
  if (request.pictureUri) body.pictureUri = request.pictureUri;
  if (request.metadataUri) body.metadataUri = request.metadataUri;
  if (request.assetAddress) body.assetAddress = request.assetAddress;
  if (request.mintAddress) body.mintAddress = request.mintAddress;
  if (request.txSignature) body.transactionSignature = request.txSignature;
  if (request.confirmedAt) body.confirmedAt = request.confirmedAt;
  // A rejected signature is the one failure the user can act on themselves,
  // so say so explicitly rather than making the client infer it.
  if (request.status === "SIGNATURE_REJECTED") body.retryAllowed = true;
  return body;
}
