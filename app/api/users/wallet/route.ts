import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { upsertUser } from "@/lib/db";
import { getClientIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { verifyChallenge, verifySolanaSignature } from "@/lib/wallet-signature";

// Links a wallet to the calling account once ownership is proven (KAN-75).
// Same challenge/signature check as /api/auth/wallet/verify (lib/wallet-
// signature.ts), but for an already-authenticated caller rather than a login
// — this is what makes walletAddr a proven value instead of the client-
// asserted one POST /api/users used to accept.
export async function POST(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [userLimited, ipLimited] = await Promise.all([
    isRateLimited("walletLinkPerUser", userId),
    isRateLimited("walletLinkPerIp", getClientIp(req)),
  ]);
  if (userLimited || ipLimited) {
    return rateLimitResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { walletAddress, challenge, signature } = (body ?? {}) as Record<string, unknown>;

  if (typeof walletAddress !== "string" || typeof challenge !== "string" || typeof signature !== "string") {
    return NextResponse.json(
      { error: "walletAddress, challenge, and signature required" },
      { status: 400 }
    );
  }

  // verifyChallenge also checks the address embedded in the challenge matches
  // walletAddress, so a caller cannot verify a signature for one wallet and
  // claim a different address with it.
  if (!verifyChallenge(challenge, walletAddress)) {
    return NextResponse.json({ error: "Invalid or expired challenge" }, { status: 401 });
  }
  if (!verifySolanaSignature(challenge, signature, walletAddress)) {
    return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
  }

  // Reached only after both checks above pass, so this address is proven.
  const user = await upsertUser({ userId, walletAddr: walletAddress, walletVerified: true });
  return NextResponse.json({ user });
}
