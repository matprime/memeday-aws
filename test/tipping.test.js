const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function load(rel) {
  return import(pathToFileURL(path.join(__dirname, "..", rel)).href);
}

// ── Amount cap (KAN-26 step 5 safety) ───────────────────────────────────────
// The amount field is free text on a real-money flow, so "10" instead of
// "0.10" is one missed keystroke from a 100x tip.

test("validateAmount: a normal tip is allowed", async () => {
  const { validateAmount } = await load("lib/solana/tip.ts");
  assert.strictEqual(validateAmount("0.01").level, "ok");
  assert.strictEqual(validateAmount("10").level, "ok", "the cap itself is inclusive");
});

test("validateAmount: above the hard cap is blocked", async () => {
  const { validateAmount, MAX_TIP_SOL } = await load("lib/solana/tip.ts");
  assert.strictEqual(MAX_TIP_SOL, 10);
  const result = validateAmount("11");
  assert.strictEqual(result.level, "block");
  assert.match(result.message, /capped at 10 SOL/);
});

test("validateAmount: zero, negative and non-numeric are blocked", async () => {
  const { validateAmount } = await load("lib/solana/tip.ts");
  for (const input of ["0", "-1", "", "abc"]) {
    assert.strictEqual(validateAmount(input).level, "block", `input: ${JSON.stringify(input)}`);
  }
});

// The soft cap ships inert (SOFT_WARN_TIP_SOL = null) pending the follow-up
// ticket that raises the hard cap. Pinning the branch here means enabling it
// later is a one-line change to a path that is already known to work.
test("validateAmount: soft-cap warn branch is inert by default but functional", async () => {
  const { validateAmount, SOFT_WARN_TIP_SOL } = await load("lib/solana/tip.ts");
  assert.strictEqual(SOFT_WARN_TIP_SOL, null, "soft cap must ship disabled");
  assert.strictEqual(validateAmount("5").level, "ok");
  const warned = validateAmount("5", { softWarn: 1 });
  assert.strictEqual(warned.level, "warn");
  assert.match(warned.message, /large tip/i);
});

// ── Solana Pay URL (KAN-26 step 3) ──────────────────────────────────────────

test("buildSolanaPayUrl: encodes recipient, amount and reference", async () => {
  const { buildSolanaPayUrl } = await load("lib/solana/tip.ts");
  const recipient = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const reference = "GDDMwNyyx8uB6zrqwBFHjLLG3TBYk2F8Az4yrQC5RzMp";

  const url = buildSolanaPayUrl(recipient, "0.05", "Tip via MemeDay", reference);

  assert.ok(url.startsWith(`solana:${recipient}?`), `got: ${url}`);
  const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  assert.strictEqual(params.get("amount"), "0.05");
  assert.strictEqual(params.get("reference"), reference);
  assert.strictEqual(params.get("label"), "MemeDay");
  assert.strictEqual(params.get("message"), "Tip via MemeDay");
});

// Without a reference there is nothing to search an explorer for, which is
// exactly what the mainnet acceptance criterion has to verify on Solscan.
test("buildSolanaPayUrl: reference is always present", async () => {
  const { buildSolanaPayUrl } = await load("lib/solana/tip.ts");
  const url = buildSolanaPayUrl("Recipient111", "1", "m", "Ref111");
  assert.match(url, /[?&]reference=Ref111/);
});

// ── Error classification (KAN-26 step 4) ────────────────────────────────────

test("classifyTipError: user cancellation is not reported as a failure", async () => {
  const { classifyTipError } = await load("lib/solana/tip.ts");

  const named = new Error("Transaction rejected");
  named.name = "WalletSignTransactionError";
  assert.strictEqual(classifyTipError(named).kind, "cancelled");

  assert.strictEqual(
    classifyTipError(new Error("User rejected the request.")).kind,
    "cancelled"
  );
  // A cancel carries no message: the UI returns quietly to the form.
  assert.strictEqual(classifyTipError(new Error("User rejected the request.")).message, "");
});

test("classifyTipError: insufficient funds", async () => {
  const { classifyTipError } = await load("lib/solana/tip.ts");
  for (const msg of [
    "Transfer: insufficient lamports 4000, need 10000000",
    "Attempt to debit an account but found no record of a prior credit.",
  ]) {
    const result = classifyTipError(new Error(msg));
    assert.strictEqual(result.kind, "insufficient", `msg: ${msg}`);
    assert.match(result.message, /Not enough SOL/);
  }
});

test("classifyTipError: timeout says the tip may still land, never that it failed", async () => {
  const { classifyTipError } = await load("lib/solana/tip.ts");
  const { ConfirmationTimeoutError } = await load("lib/solana/confirm.ts");

  const result = classifyTipError(new ConfirmationTimeoutError("5xSig"));
  assert.strictEqual(result.kind, "timeout");
  assert.match(result.message, /may still land/i);
  // Telling the user it failed would invite a blind retry and a double send.
  assert.doesNotMatch(result.message, /\bfailed\b/i);
});

test("classifyTipError: invalid recipient wallet", async () => {
  const { classifyTipError } = await load("lib/solana/tip.ts");
  const result = classifyTipError(new Error("Invalid public key input"));
  assert.strictEqual(result.kind, "invalid-recipient");
  assert.match(result.message, /nothing was sent/i);
});

test("classifyTipError: unreachable network", async () => {
  const { classifyTipError } = await load("lib/solana/tip.ts");
  const err = new TypeError("Failed to fetch");
  assert.strictEqual(classifyTipError(err).kind, "network");
});

test("classifyTipError: anything unrecognised falls back to a safe generic", async () => {
  const { classifyTipError } = await load("lib/solana/tip.ts");
  const result = classifyTipError(new Error("something entirely new"));
  assert.strictEqual(result.kind, "unknown");
  assert.ok(result.message.length > 0);
});

// ── RPC proxy allowlist (key-exposure fix) ──────────────────────────────────
// The proxy exists so the provider API key stays server-side. An unrestricted
// proxy would just be a free public RPC billed to us, so the allowlist is the
// security boundary and is tested directly.

test("rpc allowlist: methods the tip and mint flows need are permitted", async () => {
  const { isAllowedRpcBody } = await load("lib/solana/rpc-allowlist.ts");
  for (const method of [
    "getLatestBlockhash",
    "sendTransaction",
    "getSignatureStatuses",
    "getBalance",
    "getAccountInfo",
    "getMinimumBalanceForRentExemption",
  ]) {
    assert.ok(isAllowedRpcBody({ jsonrpc: "2.0", id: 1, method }), `blocked: ${method}`);
  }
});

test("rpc allowlist: expensive and abusable methods are refused", async () => {
  const { isAllowedRpcBody } = await load("lib/solana/rpc-allowlist.ts");
  for (const method of [
    "getProgramAccounts",
    "getSignaturesForAddress",
    "getBlock",
    "getTransaction",
    "getAssetsByOwner",
  ]) {
    assert.strictEqual(
      isAllowedRpcBody({ jsonrpc: "2.0", id: 1, method }),
      false,
      `allowed: ${method}`
    );
  }
});

test("rpc allowlist: a batch is rejected whole if any member is disallowed", async () => {
  const { isAllowedRpcBody } = await load("lib/solana/rpc-allowlist.ts");
  const ok = [
    { jsonrpc: "2.0", id: 1, method: "getBalance" },
    { jsonrpc: "2.0", id: 2, method: "getLatestBlockhash" },
  ];
  assert.strictEqual(isAllowedRpcBody(ok), true);

  // Otherwise a disallowed call rides along with a permitted one.
  assert.strictEqual(
    isAllowedRpcBody([...ok, { jsonrpc: "2.0", id: 3, method: "getProgramAccounts" }]),
    false
  );
});

test("rpc allowlist: malformed bodies are refused rather than forwarded", async () => {
  const { isAllowedRpcBody } = await load("lib/solana/rpc-allowlist.ts");
  for (const body of [null, undefined, {}, [], { method: 42 }, "getBalance"]) {
    assert.strictEqual(isAllowedRpcBody(body), false, `allowed: ${JSON.stringify(body)}`);
  }
});
