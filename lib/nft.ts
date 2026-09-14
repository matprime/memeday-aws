import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { walletAdapterIdentity } from "@metaplex-foundation/umi-signer-wallet-adapters";
import { create, mplCore, ruleSet } from "@metaplex-foundation/mpl-core";
import { irysUploader, type IrysUploader } from "@metaplex-foundation/umi-uploader-irys/web";
import {
  base58,
  createGenericFile,
  multiplyAmount,
  generateSigner,
  publicKey,
  type GenericFile,
  type KeypairSigner,
  type Umi,
} from "@metaplex-foundation/umi";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { Connection } from "@solana/web3.js";
import { pollSignatureConfirmation } from "@/lib/solana/confirm";
// Type-only: both modules validate server env at import time and must never be
// pulled into the client bundle. The values themselves arrive as props via
// components/WalletProvider.tsx.
import type { NftStorageProvider } from "@/lib/nft-config";
import type { SolanaNetwork } from "@/lib/solana/network";
import type { MintStatus } from "@/lib/types";
import { checkUri, isUserRejection, onChainName } from "@/lib/nft-shared";

// Irys picks its node from umi's cluster, which our RPC proxy URL cannot
// declare, so the node is chosen explicitly from the network we were handed.
const IRYS_NODE: Record<SolanaNetwork, string> = {
  devnet: "https://devnet.irys.xyz",
  mainnet: "https://uploader.irys.xyz",
};

// The user declined the wallet prompt. Its own error type because it is the
// one failure the user can act on: the request keeps its uploaded URIs and may
// be signed again, and nothing retries it without them asking.
export class MintSignatureRejectedError extends Error {
  constructor() {
    super("You declined the transaction. Your upload is saved — try again when ready.");
    this.name = "MintSignatureRejectedError";
  }
}

// The transaction was submitted but the chain has not shown us the asset yet.
// Not a failure: the mint request stays open and reconciliation finishes it.
export class MintPendingError extends Error {
  assetId: string;
  constructor(assetId: string) {
    super("Your mint was submitted but has not confirmed yet. It will appear once it lands.");
    this.name = "MintPendingError";
    this.assetId = assetId;
  }
}

export interface MintResult {
  mintAddress: string;
  signature?: string;
}

export interface MintParams {
  wallet: WalletContextState;
  // The pending upload id, which finalizeMeme reuses as the meme id — one id
  // for the asset's whole life, which is what the server keys the request on.
  assetId: string;
  imageUrl: string;
  caption: string;
  rpcUrl: string;
  network: SolanaNetwork;
  storageProvider: NftStorageProvider;
  royaltyBasisPoints: number;
  getToken: () => Promise<string>;
  onStage?: (stage: MintStatus) => void;
  // Both optional, and both only worth passing when the caller started the
  // storage payment early — see createMintUmi and prefundStorage.
  umi?: Umi;
  storageReady?: Promise<unknown>;
}

// The wire shape of every /api/mint/* response we care about.
interface MintRequestResponse {
  status: MintStatus;
  nonce?: string;
  pictureUri?: string;
  metadataUri?: string;
  assetAddress?: string;
  mintAddress?: string;
  transactionSignature?: string;
  error?: string;
  // Set on a 422: the verifier's coded objection (URI_MISMATCH,
  // METADATA_UNREACHABLE, ROYALTY_MISMATCH, …). Never provider text.
  reason?: string;
  pending?: boolean;
}

async function mintApi(
  path: string,
  token: string,
  body: unknown
): Promise<{ status: number; data: MintRequestResponse }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as MintRequestResponse;
  return { status: res.status, data };
}

function apiError(data: MintRequestResponse, fallback: string): Error {
  return new Error(data.error ?? fallback);
}

// The metadata document, served by /api/nft-metadata, for both providers. Its
// image field is what the verifier compares against the picture uri the server
// stored, so it is written from that value and nothing else.
async function registerMetadataUri(
  imageUri: string,
  caption: string,
  token: string
): Promise<string> {
  const res = await fetch("/api/nft-metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: onChainName(caption),
      image: imageUri,
      description: "Meme NFT — MemeDay on Solana",
    }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Metadata registration failed (${res.status})`);
  }
  const { uri } = (await res.json()) as { uri: string };
  return uri;
}

// Source is the CloudFront URL rather than the File the user picked: that
// object has already been through the S3Handler Lambda's sharp validation, so
// pinning it is what keeps the moderation gate in front of permanent storage.
async function fetchPicture(imageUrl: string): Promise<GenericFile> {
  const res = await fetch(imageUrl, { cache: "no-store" });
  if (!res.ok) throw new Error("Could not read the uploaded image for minting");
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const bytes = new Uint8Array(await res.arrayBuffer());
  const extension = contentType === "image/png" ? "png" : "jpg";
  return createGenericFile(bytes, `meme.${extension}`, { contentType });
}

// Built here rather than inside mintMemeNft so the caller can create it early
// and start paying for storage while the image is still being validated.
export function createMintUmi(
  wallet: WalletContextState,
  rpcUrl: string,
  network: SolanaNetwork
): Umi {
  const umi = createUmi(rpcUrl)
    .use(mplCore())
    .use(walletAdapterIdentity(wallet as any))
    .use(irysUploader({ address: IRYS_NODE[network] }));

  // umi's confirmTransaction delegates to web3.js Connection.confirmTransaction,
  // which waits on a signatureSubscribe WebSocket. rpcUrl points at our
  // /api/rpc proxy (a serverless route that cannot hold a socket open), so that
  // subscription never fires and a landed mint would still time out. Swap in the
  // HTTP polling used by the tip path — see lib/solana/confirm.ts.
  // Exposed as a getter by umi-rpc-web3js but absent from the RpcInterface type.
  const web3Connection = (umi.rpc as unknown as { connection: Connection }).connection;
  umi.rpc.confirmTransaction = async (signature, options) => {
    const sig = base58.deserialize(signature)[0];
    await pollSignatureConfirmation(web3Connection, sig, options.commitment);
    return { context: { slot: await web3Connection.getSlot() }, value: { err: null } };
  };
  return umi;
}

// The slowest thing in the whole flow, by a wide margin: the upload cannot
// start until the wallet's Irys balance covers it, and that means a transaction
// confirming and then the Irys node crediting it — around 40 seconds.
//
// Two changes to that. It is startable before the image has finished
// validating, since the price depends only on the byte count. And it tops up
// several uploads' worth at once, so the next mint from this wallet finds a
// balance already there and skips the payment entirely: one approval instead of
// two, and none of the wait. The balance is the user's own and stays theirs.
const FUND_UPLOADS_AHEAD = 5;
// A ceiling on what one top-up may ask for, so an unexpected price never turns
// into a surprise charge. Roughly the rent of a single mint.
const MAX_FUND_LAMPORTS = BigInt(4_000_000);

export async function prefundStorage(umi: Umi, bytes: number): Promise<void> {
  const uploader = umi.uploader as IrysUploader;
  const price = await uploader.getUploadPriceFromBytes(bytes);
  const balance = await uploader.getBalance();
  if (balance.basisPoints >= price.basisPoints) return;

  const target = multiplyAmount(price, FUND_UPLOADS_AHEAD);
  const capped = target.basisPoints > MAX_FUND_LAMPORTS ? price : target;
  // fund() subtracts the existing balance itself, so this asks only for the
  // difference and does nothing when the balance already covers it.
  await uploader.fund(capped, false);
}

export async function mintMemeNft(params: MintParams): Promise<MintResult> {
  const {
    wallet,
    assetId,
    imageUrl,
    caption,
    rpcUrl,
    network,
    storageProvider,
    royaltyBasisPoints,
    getToken,
    onStage,
  } = params;

  if (!wallet.connected || !wallet.publicKey) {
    throw new Error("Wallet not connected — reconnect your wallet and try again.");
  }
  const ownerWallet = wallet.publicKey.toBase58();

  // 1. Prepare. Creates the request or resumes the existing one; never a
  // second request for one asset. No wallet prompt happens here.
  onStage?.("PENDING");
  const prepared = await mintApi("/api/mint/prepare", await getToken(), {
    assetId,
    ownerWallet,
  });
  if (prepared.status === 409 && prepared.data.status === "CONFIRMED" && prepared.data.mintAddress) {
    return {
      mintAddress: prepared.data.mintAddress,
      signature: prepared.data.transactionSignature,
    };
  }
  if (prepared.status !== 200 && prepared.status !== 201) {
    throw apiError(prepared.data, "Could not start the mint");
  }

  let state = prepared.data;
  let nonce = state.nonce;
  if (!nonce) throw new Error("Could not start the mint");

  const advance = async (
    to: MintStatus,
    patch: Record<string, string> = {}
  ): Promise<void> => {
    const { status, data } = await mintApi("/api/mint/uploads", await getToken(), {
      assetId,
      nonce,
      advance: to,
      ...patch,
    });
    if (status !== 200) {
      // 422 is the server refusing to let an unreadable metadata document
      // reach the chain. Its code says which check failed, and it arrives
      // before the wallet is asked, so nothing has been paid.
      if (data.reason) {
        const at = data.metadataUri ? ` at ${data.metadataUri}` : "";
        throw new Error(`${data.error ?? "Mint check failed"} (${data.reason})${at}`);
      }
      throw apiError(data, "Could not record the mint progress");
    }
    state = { ...state, ...data };
    nonce = data.nonce;
  };

  const umi = params.umi ?? createMintUmi(wallet, rpcUrl, network);

  // 2. Picture. Skipped when a previous attempt already stored it — the user
  // has paid for that storage once and must not pay again on a retry.
  if (!state.pictureUri) {
    onStage?.("UPLOADING_PICTURE");
    // The image is read from CloudFront while the status round-trip is in
    // flight: it is the largest download in the flow and does not depend on it.
    const picture = storageProvider === "irys" ? fetchPicture(imageUrl) : null;
    await advance("UPLOADING_PICTURE");
    // Whatever the caller started earlier has to be done before the upload,
    // and its failures belong to the user here rather than to an unhandled
    // rejection somewhere behind the modal.
    if (params.storageReady) await params.storageReady;
    const pictureUri = picture
      ? (await umi.uploader.upload([await picture]))[0]
      : imageUrl;
    await advance("UPLOADING_METADATA", {
      pictureUri: checkUri(pictureUri, "Image URI"),
    });
  }

  const pictureUri = state.pictureUri;
  if (!pictureUri) throw new Error("Could not record the image for this mint");

  // 3. Metadata. The image field must equal the picture URI the server stored:
  // it re-fetches this document and compares before confirming anything.
  // The asset keypair is generated here and its address recorded BEFORE the
  // wallet is asked, so a mint that lands after the browser dies can still be
  // found on-chain without the transaction signature.
  if (!state.metadataUri || state.status === "UPLOADING_METADATA") {
    onStage?.("UPLOADING_METADATA");
    // Deliberately not a second Irys upload. Each one tops the wallet's Irys
    // balance up with its own on-chain transaction and signs its own data
    // item, so putting a 1KB JSON there cost two extra wallet prompts and the
    // wait for another confirmation — for a document we can serve ourselves.
    // The picture, which is the part that must outlive us, stays on Arweave.
    const metadataUri = await registerMetadataUri(pictureUri, caption, await getToken());
    const asset = generateSigner(umi);
    await advance("AWAITING_SIGNATURE", {
      metadataUri: checkUri(metadataUri, "Metadata URI"),
      assetAddress: asset.publicKey.toString(),
    });
    return signAndConfirm({ ...params, umi, asset, metadataUri, ownerWallet });
  }

  // Resumed at or past the signing step. Re-signing here could double-mint: an
  // earlier attempt may have landed a transaction we never heard about. Ask
  // the chain instead, and let the user retry from a rejection explicitly.
  if (state.status === "SIGNATURE_REJECTED") {
    const asset = generateSigner(umi);
    const metadataUri = state.metadataUri;
    await advance("AWAITING_SIGNATURE", {
      metadataUri,
      assetAddress: asset.publicKey.toString(),
    });
    return signAndConfirm({ ...params, umi, asset, metadataUri, ownerWallet });
  }

  onStage?.("MINTING");
  return confirmWithServer(assetId, undefined, getToken);
}

async function signAndConfirm(args: {
  assetId: string;
  caption: string;
  umi: Umi;
  asset: KeypairSigner;
  // The URI the server recorded, not a local copy of it: the verifier compares
  // what is on-chain against its own stored value.
  metadataUri: string;
  ownerWallet: string;
  royaltyBasisPoints: number;
  getToken: () => Promise<string>;
  onStage?: (stage: MintStatus) => void;
}): Promise<MintResult> {
  const {
    assetId,
    caption,
    umi,
    asset,
    metadataUri,
    ownerWallet,
    royaltyBasisPoints,
    getToken,
    onStage,
  } = args;

  onStage?.("AWAITING_SIGNATURE");

  let signature: string;
  try {
    // sendAndConfirm builds the transaction fresh, so a retry after a rejected
    // signature gets a new blockhash without any extra bookkeeping here.
    const result = await create(umi, {
      asset,
      name: onChainName(caption),
      uri: metadataUri,
      plugins: [
        {
          type: "Royalties",
          basisPoints: royaltyBasisPoints,
          creators: [{ address: publicKey(ownerWallet), percentage: 100 }],
          ruleSet: ruleSet("None"),
        },
        { type: "ImmutableMetadata" },
      ],
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    signature = base58.deserialize(result.signature)[0];
  } catch (err) {
    if (isUserRejection(err)) {
      // No transaction was submitted. Park the request so the uploads survive
      // and the user can sign later; never re-open the wallet on their behalf.
      await mintApi("/api/mint/reject", await getToken(), { assetId });
      throw new MintSignatureRejectedError();
    }
    if (err instanceof TypeError && err.message === "Failed to fetch") {
      throw new Error("Solana RPC unreachable — check your connection and try again.");
    }
    throw err;
  }

  onStage?.("MINTING");
  return confirmWithServer(assetId, signature, getToken);
}

// Nothing is minted until the server says so: it checks the chain, the owner,
// the URIs and the royalty before it will record anything.
async function confirmWithServer(
  assetId: string,
  signature: string | undefined,
  getToken: () => Promise<string>
): Promise<MintResult> {
  const { status, data } = await mintApi("/api/mint/confirm", await getToken(), {
    assetId,
    signature,
  });
  if (status === 200 && data.mintAddress) {
    return { mintAddress: data.mintAddress, signature: data.transactionSignature ?? signature };
  }
  if (status === 202) throw new MintPendingError(assetId);
  if (data.reason) {
    throw new Error(`The mint could not be verified on-chain (${data.reason})`);
  }
  throw apiError(data, "The mint could not be verified on-chain");
}
