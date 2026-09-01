import { NextResponse } from "next/server";
import { isBagsLiveModeEnabled, getBagsPartnerPair } from "@/lib/bags-server";

// No auth, no rate limit: off mainnet this returns a fixed `{ live: false }`
// without reading a single Bags env var (correction 2). On mainnet it adds
// two non-secret values (they end up in the public Launch Intent URL and the
// partner wallet is readable on-chain anyway) so the client can build that
// URL — kept server-side per the ticket rather than NEXT_PUBLIC_.
export async function GET() {
  if (!isBagsLiveModeEnabled()) {
    return NextResponse.json({ live: false });
  }
  const { partnerWallet, partnerConfig } = getBagsPartnerPair();
  return NextResponse.json({ live: true, partnerWallet, partnerConfig });
}
