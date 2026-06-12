import { createHmac, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";

const secret = () => {
  const s = process.env.WALLET_AUTH_SECRET;
  if (!s) throw new Error("WALLET_AUTH_SECRET not set");
  return s;
};

export async function POST(req: NextRequest) {
  const { walletAddress } = await req.json();
  if (!walletAddress || typeof walletAddress !== "string") {
    return NextResponse.json({ error: "walletAddress required" }, { status: 400 });
  }

  const ts = Date.now();
  const rand = randomBytes(8).toString("hex");
  const nonce = `${ts}:${walletAddress}:${rand}`;
  const hmac = createHmac("sha256", secret()).update(nonce).digest("hex");

  // challenge = nonce.hmac — self-contained, no server storage needed
  return NextResponse.json({ challenge: `${nonce}.${hmac}` });
}
