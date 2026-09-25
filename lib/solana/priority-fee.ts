import { publicKey, type WrappedInstruction } from "@metaplex-foundation/umi";

// Priority fee for the mint transaction (KAN-100). Without one, a mainnet mint
// can be dropped. Kept free of "@/" imports and network calls so the fee
// arithmetic is unit tested directly; lib/nft.ts fetches the samples.
//
// Cost is bounded: the most a mint can pay in priority fee is
// MAX_PRIORITY_MICROLAMPORTS * MINT_COMPUTE_UNIT_LIMIT / 1e6 = 10,000 lamports.

// Micro-lamports per compute unit.
export const MIN_PRIORITY_MICROLAMPORTS = 1_000;
export const MAX_PRIORITY_MICROLAMPORTS = 50_000;
// umi's default for a single-instruction transaction. Set explicitly so the
// bound above is stated rather than assumed, and not lowered below what the
// create instruction with its plugins may use.
export const MINT_COMPUTE_UNIT_LIMIT = 200_000;

const COMPUTE_BUDGET_PROGRAM = publicKey("ComputeBudget111111111111111111111111111111");

// Median of the non-zero samples, clamped to [MIN, MAX]. Zeros are slots where
// nobody paid for priority, so they say nothing about the price to land now.
// No usable samples (the lookup failed or came back empty) gives the floor.
export function choosePriorityFee(samples: { prioritizationFee: number }[]): number {
  const fees = samples
    .map((s) => s.prioritizationFee)
    .filter((fee) => Number.isFinite(fee) && fee > 0)
    .sort((a, b) => a - b);
  if (fees.length === 0) return MIN_PRIORITY_MICROLAMPORTS;
  const median = fees[Math.floor(fees.length / 2)];
  return Math.min(MAX_PRIORITY_MICROLAMPORTS, Math.max(MIN_PRIORITY_MICROLAMPORTS, Math.round(median)));
}

function wrap(data: Uint8Array): WrappedInstruction {
  return {
    instruction: { keys: [], programId: COMPUTE_BUDGET_PROGRAM, data },
    signers: [],
    bytesCreatedOnChain: 0,
  };
}

// SetComputeUnitLimit is instruction 2 (u32 LE), SetComputeUnitPrice is 3
// (u64 LE). Throws above the cap so no caller can build an unbounded fee, even
// by passing a price that did not come from choosePriorityFee.
export function computeBudgetInstructions(microLamports: number): WrappedInstruction[] {
  if (!Number.isInteger(microLamports) || microLamports < 0 || microLamports > MAX_PRIORITY_MICROLAMPORTS) {
    throw new Error(`Priority fee out of bounds: ${microLamports}`);
  }
  const limit = new Uint8Array(5);
  limit[0] = 2;
  new DataView(limit.buffer).setUint32(1, MINT_COMPUTE_UNIT_LIMIT, true);
  const price = new Uint8Array(9);
  price[0] = 3;
  new DataView(price.buffer).setBigUint64(1, BigInt(microLamports), true);
  return [wrap(limit), wrap(price)];
}
