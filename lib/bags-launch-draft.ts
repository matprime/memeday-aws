import { LAMPORTS_PER_SOL } from "@solana/web3.js";

// WHY 0.05: KAN-107 measured a Bags launch at 0.047 SOL with no initial buy, so
// this is that cost plus a little headroom. It is a warning threshold only,
// never a gate: the launch itself happens on bags.fm, not here.
export const BAGS_LAUNCH_MIN_SOL = 0.05;

// Pure so the below / equal / above boundary can be tested without a wallet.
// Equal is not below: a wallet holding exactly the minimum gets no warning.
export function isBelowBagsLaunchMin(balanceLamports: number): boolean {
  return balanceLamports < Math.round(BAGS_LAUNCH_MIN_SOL * LAMPORTS_PER_SOL);
}

export interface BagsLaunchDraft {
  name: string;
  ticker: string;
  description: string;
}

export function bagsLaunchDraftKey(memeId: string): string {
  return `memeday:bags-launch:${memeId}`;
}

// Every storage access is wrapped: localStorage can be absent or throw in
// private windows, with blocked site data, or under quota. A draft is a
// convenience, so failure means "no draft", never an error for the caller.
export function saveBagsLaunchDraft(memeId: string, draft: BagsLaunchDraft): void {
  try {
    localStorage.setItem(bagsLaunchDraftKey(memeId), JSON.stringify(draft));
  } catch {
    // Storage unavailable: nothing to do.
  }
}

export function loadBagsLaunchDraft(memeId: string): Partial<BagsLaunchDraft> | null {
  try {
    const raw = localStorage.getItem(bagsLaunchDraftKey(memeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // Keep only string fields so a hand-edited or stale value can't put a
    // non-string into the form state.
    const draft: Partial<BagsLaunchDraft> = {};
    if (typeof parsed.name === "string") draft.name = parsed.name;
    if (typeof parsed.ticker === "string") draft.ticker = parsed.ticker;
    if (typeof parsed.description === "string") draft.description = parsed.description;
    return draft;
  } catch {
    return null;
  }
}

export function clearBagsLaunchDraft(memeId: string): void {
  try {
    localStorage.removeItem(bagsLaunchDraftKey(memeId));
  } catch {
    // Storage unavailable: nothing to do.
  }
}
