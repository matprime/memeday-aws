import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  const body = await req.json().catch(() => ({} as unknown));
  const walletAddress =
    typeof (body as { wallet_address?: unknown }).wallet_address === "string"
      ? (body as { wallet_address: string }).wallet_address
      : null;

  if (!walletAddress) {
    return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("vote_on_meme", {
    p_meme_id: id,
    p_wallet_address: walletAddress,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, total_votes: data ?? 0 });
}
