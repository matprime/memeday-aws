// Pure tip logic, kept out of components/TipModal.tsx so it can be tested
// without a DOM (this repo runs node:test, no jsdom).

// Hard ceiling. The amount field is free text, so "10" instead of "0.10" is a
// single missed keystroke away from a 100x tip on mainnet.
export const MAX_TIP_SOL = 10;

// Scaffold for the follow-up ticket: raise MAX_TIP_SOL and warn above this
// instead of blocking. null keeps the "warn" branch inert until then — set a
// number here and wire the confirmation step in TipModal to switch it on.
export const SOFT_WARN_TIP_SOL: number | null = null;

export type TipAmountLevel = "ok" | "warn" | "block";

export interface TipAmountValidation {
  level: TipAmountLevel;
  message?: string;
}

export function validateAmount(
  raw: string,
  options: { max?: number; softWarn?: number | null } = {}
): TipAmountValidation {
  const max = options.max ?? MAX_TIP_SOL;
  const softWarn = options.softWarn === undefined ? SOFT_WARN_TIP_SOL : options.softWarn;

  const value = parseFloat(raw);
  if (isNaN(value)) {
    return { level: "block", message: "Enter a valid SOL amount." };
  }
  if (value <= 0) {
    return { level: "block", message: "Tip amount must be greater than zero." };
  }
  if (value > max) {
    return {
      level: "block",
      message: `Tips are capped at ${max} SOL. Enter a smaller amount.`,
    };
  }
  if (softWarn !== null && value > softWarn) {
    return {
      level: "warn",
      message: `That's a large tip — confirm you meant ${value} SOL.`,
    };
  }
  return { level: "ok" };
}

// Solana Pay transfer request URL — spec: https://docs.solanapay.com/spec#transfer-request
// `reference` is a throwaway pubkey attached to both the QR and the on-chain
// transaction, so a completed tip can be found on an explorer afterwards.
export function buildSolanaPayUrl(
  recipient: string,
  amount: string,
  message: string,
  reference: string
) {
  const params = new URLSearchParams({
    amount,
    label: "MemeDay",
    message,
    reference,
  });
  return `solana:${recipient}?${params}`;
}

export type TipErrorKind =
  | "cancelled"
  | "insufficient"
  | "timeout"
  | "network"
  | "invalid-recipient"
  | "unknown";

export interface TipError {
  kind: TipErrorKind;
  message: string;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function classifyTipError(err: unknown): TipError {
  const text = errorText(err);
  const name = err instanceof Error ? err.name : "";

  // Checked first: a rejection message can also mention the transaction, and
  // cancelling is a normal user choice rather than a failure to report loudly.
  if (
    name === "WalletSignTransactionError" ||
    /user rejected|user declined|request rejected|rejected the request/i.test(text)
  ) {
    return { kind: "cancelled", message: "" };
  }

  if (
    /insufficient lamports|insufficient funds|debit an account but found no record of a prior credit/i.test(
      text
    )
  ) {
    return {
      kind: "insufficient",
      message: "Not enough SOL in your wallet to cover this tip plus network fees.",
    };
  }

  if (/invalid public key/i.test(text)) {
    return {
      kind: "invalid-recipient",
      message: "This creator's wallet address is invalid — nothing was sent.",
    };
  }

  if (
    name === "ConfirmationTimeoutError" ||
    /TransactionExpired|timed out|timeout/i.test(text)
  ) {
    // Deliberately not "failed": the transaction may still land after we stop
    // watching, so telling the user to retry blindly could double-send.
    return {
      kind: "timeout",
      message:
        "Network is slow — your tip may still land. Check the explorer before retrying.",
    };
  }

  if (name === "TypeError" && /failed to fetch|networkerror/i.test(text)) {
    return {
      kind: "network",
      message: "Can't reach the Solana network right now. Check your connection.",
    };
  }

  return { kind: "unknown", message: "Tip failed. Please try again." };
}
