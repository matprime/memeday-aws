import { NextResponse } from "next/server";
import { upsertUser } from "@/lib/db";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { wallet_address, bags_project_id, creator_token_address } = body;

    if (!wallet_address) {
      return NextResponse.json({ error: "wallet_address is required" }, { status: 400 });
    }

    const user = await upsertUser({ wallet_address, bags_project_id, creator_token_address });
    return NextResponse.json({ user });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
