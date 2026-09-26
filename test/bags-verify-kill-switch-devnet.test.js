const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// Devnet with the kill switch off: proves Preview/devnet behavior is unchanged.
process.env.SOLANA_NETWORK = "devnet";
process.env.SOLANA_ENABLED = "false";
process.env.VERCEL_ENV = "preview";
process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";

const stubUrl = pathToFileURL(path.join(__dirname, "helpers", "bags-verify-stubs.mjs")).href;
const stubbed = new Set(["@/lib/db", "@/lib/cognito", "@/lib/rate-limit"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubbed.has(specifier)) {
      return { url: stubUrl, shortCircuit: true };
    }
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(__dirname, "..", specifier.slice(2) + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

function load(rel) {
  return import(pathToFileURL(path.join(__dirname, "..", rel)).href);
}

function verifyRequest() {
  return new Request("http://localhost/api/bags/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ memeId: "m1", name: "Token", symbol: "TKN" }),
  });
}

test("bags/verify: kill switch does not gate off mainnet, an unauthenticated request reaches auth and gets 401", async () => {
  const { POST } = await load("app/api/bags/verify/route.ts");
  const res = await POST(verifyRequest());
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(globalThis.__bagsVerifyCalls, ["getUserIdFromRequest"]);
});
