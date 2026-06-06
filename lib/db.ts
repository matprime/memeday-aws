import { unstable_noStore as noStore } from "next/cache";
import { getSupabase, getSupabaseAdmin } from "./supabase";
import { DbComment, DbMeme, DbUser } from "./types";

export async function getMemes(): Promise<DbMeme[]> {
  noStore();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("memes")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getMemesToday(): Promise<DbMeme[]> {
  noStore();
  const supabase = getSupabase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("memes")
    .select("*")
    .gte("created_at", today.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getMemesThisWeek(): Promise<DbMeme[]> {
  noStore();
  const supabase = getSupabase();
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const { data, error } = await supabase
    .from("memes")
    .select("*")
    .gte("created_at", weekAgo.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getMemeOfDay(): Promise<DbMeme | null> {
  noStore();
  const supabase = getSupabase();
  const { data } = await supabase
    .from("memes")
    .select("*")
    .order("total_votes", { ascending: false })
    .limit(1)
    .single();
  return data ?? null;
}

export async function getMemeById(id: string): Promise<DbMeme | null> {
  noStore();
  const supabase = getSupabase();
  const { data } = await supabase
    .from("memes")
    .select("*")
    .eq("id", id)
    .single();
  return data ?? null;
}

export async function getMemesByCreator(wallet: string): Promise<DbMeme[]> {
  noStore();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("memes")
    .select("*")
    .eq("creator_wallet", wallet)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function createMeme(
  meme: Omit<DbMeme, "id" | "created_at" | "total_votes">
): Promise<DbMeme> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("memes")
    .insert({ ...meme, total_votes: 0 })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getComments(memeId: string): Promise<DbComment[]> {
  noStore();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("comments")
    .select("*")
    .eq("meme_id", memeId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function addComment(
  comment: Pick<DbComment, "meme_id" | "user_wallet" | "text">
): Promise<DbComment> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("comments")
    .insert({ ...comment, likes: 0 })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function upsertUser(
  user: Partial<DbUser> & { wallet_address: string }
): Promise<DbUser> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("users")
    .upsert(user, { onConflict: "wallet_address" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getUserByWallet(wallet: string): Promise<DbUser | null> {
  noStore();
  const supabase = getSupabase();
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("wallet_address", wallet)
    .single();
  return data ?? null;
}

export async function getCreatorsWithMemeCounts(): Promise<
  Array<DbUser & { memeCount: number; joinedAt: string }>
> {
  noStore();
  const supabase = getSupabase();
  const [usersRes, memesRes] = await Promise.all([
    supabase.from("users").select("*"),
    supabase
      .from("memes")
      .select("creator_wallet, created_at")
      .order("created_at", { ascending: true }),
  ]);

  const memeCounts = new Map<string, number>();
  const firstMemeAt = new Map<string, string>();
  for (const meme of memesRes.data ?? []) {
    memeCounts.set(meme.creator_wallet, (memeCounts.get(meme.creator_wallet) ?? 0) + 1);
    if (!firstMemeAt.has(meme.creator_wallet)) {
      firstMemeAt.set(meme.creator_wallet, meme.created_at);
    }
  }

  return (usersRes.data ?? []).map((u) => ({
    ...u,
    memeCount: memeCounts.get(u.wallet_address) ?? 0,
    joinedAt: firstMemeAt.get(u.wallet_address) ?? new Date().toISOString(),
  }));
}

export interface NftMetadataRow {
  id: string;
  name: string;
  image_url: string;
  description: string;
}

export async function createNftMetadata(row: {
  name: string;
  image_url: string;
  description: string;
}): Promise<{ id: string }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("nft_metadata")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id };
}

export async function getNftMetadata(id: string): Promise<NftMetadataRow | null> {
  noStore();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("nft_metadata")
    .select("id, name, image_url, description")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}
