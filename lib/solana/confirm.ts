import type { Commitment, Connection } from "@solana/web3.js";

// web3.js's Connection.confirmTransaction waits on a `signatureSubscribe`
// WebSocket, deriving wss:// from the HTTP endpoint. Our RPC endpoint is
// app/api/rpc (a serverless route that cannot hold a socket open), so that
// subscription would never fire and confirmation would fail ~60s later even
// for a transaction that landed. Polling getSignatureStatuses over plain HTTP
// gets the same answer through the proxy, on devnet and mainnet alike.

export class ConfirmationTimeoutError extends Error {
  readonly signature: string;
  constructor(signature: string) {
    super(`Timed out confirming ${signature}`);
    this.name = "ConfirmationTimeoutError";
    this.signature = signature;
  }
}

export class TransactionFailedError extends Error {
  readonly signature: string;
  constructor(signature: string, err: unknown) {
    super(`Transaction ${signature} failed on-chain: ${JSON.stringify(err)}`);
    this.name = "TransactionFailedError";
    this.signature = signature;
  }
}

export async function pollSignatureConfirmation(
  connection: Connection,
  signature: string,
  commitment: Commitment = "confirmed",
  timeoutMs = 60_000,
  intervalMs = 1_500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];

    if (status) {
      // An on-chain error is terminal — retrying or waiting cannot change it.
      if (status.err) throw new TransactionFailedError(signature, status.err);
      // "finalized" also satisfies a "confirmed" request; it is strictly later.
      if (
        status.confirmationStatus === commitment ||
        status.confirmationStatus === "finalized"
      ) {
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  // Not the same as failure: the transaction may still land after we stop
  // watching, so callers must say "may still arrive", never "it failed".
  throw new ConfirmationTimeoutError(signature);
}
