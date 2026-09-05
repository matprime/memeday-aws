import { NextResponse } from "next/server";
import { getUserIdFromRequest, getWalletAddressFromRequest } from "@/lib/cognito";
import { upsertUser } from "@/lib/db";

export async function POST(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    // walletAddr is never trusted from the body (KAN-75): it was previously
    // client-asserted with no ownership proof. A wallet-authenticated caller
    // already has a server-verified address on the token; anyone else links
    // one through POST /api/users/wallet instead.
    // creatorTokenAddr/creatorTokenSymbol are never trusted from the body
    // either (KAN-75 comment 12056): same unproven-client-write bug as
    // walletAddr above. Ignored rather than erroring, so an older client
    // does not break.
    const { email, displayName, authMethods, bagsProjectId } = body;
    const walletAddr = (await getWalletAddressFromRequest(req)) ?? undefined;

    const user = await upsertUser({
      userId,
      email,
      walletAddr,
      // Present only when it came off the token, so this is always proven.
      walletVerified: walletAddr !== undefined,
      displayName,
      authMethods,
      bagsProjectId,
    });

    return NextResponse.json({ user });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
