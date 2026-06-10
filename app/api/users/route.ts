import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/cognito";
import { upsertUser } from "@/lib/db";

export async function POST(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { email, walletAddr, displayName, authMethods, bagsProjectId, creatorTokenAddr } = body;

    const user = await upsertUser({
      userId,
      email,
      walletAddr,
      displayName,
      authMethods,
      bagsProjectId,
      creatorTokenAddr,
    });

    return NextResponse.json({ user });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
