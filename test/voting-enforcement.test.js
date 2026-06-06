const { test } = require("node:test");
const assert = require("node:assert");
const { createClient } = require("@supabase/supabase-js");

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test("voting: server enforces one vote per wallet per meme", async (t) => {
  const supabase = getAdminClient();
  if (!supabase) {
    t.skip("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return;
  }

  const wallet = `test_wallet_${Date.now()}`;

  const { data: meme, error: memeInsertErr } = await supabase
    .from("memes")
    .insert({
      creator_wallet: wallet,
      image_url: "https://example.com/test.png",
      caption: "test meme",
      price: null,
      is_for_sale: false,
      is_nft: false,
      total_votes: 0,
    })
    .select("id,total_votes")
    .single();

  assert.ifError(memeInsertErr);
  assert.ok(meme?.id, "expected inserted meme id");

  try {
    const { data: v1, error: vote1Err } = await supabase.rpc("vote_on_meme", {
      p_meme_id: meme.id,
      p_wallet_address: wallet,
    });
    assert.ifError(vote1Err);
    assert.strictEqual(v1, 1, "first vote should increment to 1");

    const { data: v2, error: vote2Err } = await supabase.rpc("vote_on_meme", {
      p_meme_id: meme.id,
      p_wallet_address: wallet,
    });
    assert.ifError(vote2Err);
    assert.strictEqual(v2, 1, "second vote should not increment");

    const { data: memeAfter, error: fetchErr } = await supabase
      .from("memes")
      .select("total_votes")
      .eq("id", meme.id)
      .single();
    assert.ifError(fetchErr);
    assert.strictEqual(memeAfter.total_votes, 1, "memes.total_votes should remain 1");

    const { count, error: votesCountErr } = await supabase
      .from("meme_votes")
      .select("id", { count: "exact", head: true })
      .eq("meme_id", meme.id)
      .eq("wallet_address", wallet);
    assert.ifError(votesCountErr);
    assert.strictEqual(count, 1, "meme_votes should contain exactly one row");
  } catch (e) {
    // Helpful failure when migration wasn't applied yet.
    if (String(e?.message || "").includes("vote_on_meme")) {
      throw new Error(
        `Missing RPC/function/table in Supabase. Did you apply supabase/migrations/20260505_150100_meme_votes.sql?\nOriginal: ${e.message}`
      );
    }
    throw e;
  } finally {
    // meme_votes rows should cascade-delete on meme delete.
    await supabase.from("memes").delete().eq("id", meme.id);
  }
});

