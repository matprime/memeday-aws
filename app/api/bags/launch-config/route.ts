import { NextResponse } from "next/server";
import { isBagsLiveModeEnabled, getBagsPartnerPair } from "@/lib/bags-server";
import { getUserIdFromRequest, getWalletAddressFromRequest } from "@/lib/cognito";
import { isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

// Authenticated (KAN-75): the response now carries walletAuthed, derived
// server-side from the access token, so the client can gate the launch flow
// on a proven signal instead of trusting itself. Off mainnet this still
// returns `{ live: false }` without reading a single Bags env var
// (correction 2 from KAN-29) — walletAuthed is computed before that check,
// from the token alone, so it never touches Bags config either.
export async function GET(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (await isRateLimited("bagsLaunchConfigPerUser", userId)) {
    return rateLimitResponse();
  }

  const walletAuthed = (await getWalletAddressFromRequest(req)) !== null;

  if (!isBagsLiveModeEnabled()) {
    return NextResponse.json({ live: false, walletAuthed });
  }
  const { partnerWallet, partnerConfig } = getBagsPartnerPair();
  return NextResponse.json({ live: true, walletAuthed, partnerWallet, partnerConfig });
}
