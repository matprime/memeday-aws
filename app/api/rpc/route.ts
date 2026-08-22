import { NextRequest, NextResponse } from "next/server";
import { SOLANA_RPC_URL } from "@/lib/solana/network";
import { isAllowedRpcBody } from "@/lib/solana/rpc-allowlist";
import { getClientIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

// Server-side JSON-RPC forwarder. SOLANA_RPC_URL carries the provider API key,
// so it must never reach the browser — the client talks to this route and this
// route talks to the provider. See lib/solana/network.ts for the split between
// the upstream URL and SOLANA_CLIENT_RPC_PATH, and lib/solana/rpc-allowlist.ts
// for which methods are permitted through.

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!isAllowedRpcBody(body)) {
    return NextResponse.json({ error: "rpc method not allowed" }, { status: 403 });
  }

  // Checked after the allowlist on purpose: a disallowed method should still
  // get its 403 without spending the caller's rate budget.
  if (await isRateLimited("rpcPerIp", getClientIp(request))) {
    return rateLimitResponse();
  }

  try {
    const upstream = await fetch(SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Pass the provider's response through untouched: web3.js parses JSON-RPC
    // error objects itself and needs them intact to classify failures.
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    // Deliberately does not include the caught error: a fetch failure message
    // embeds the upstream URL, which is the key we are hiding.
    return NextResponse.json({ error: "rpc upstream unreachable" }, { status: 502 });
  }
}
