const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { hasAwsCredentials } = require("./helpers/aws-credentials");

// Same module-resolution shims as email-login.test.js — see the comment there.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.join(__dirname, "..", specifier.slice(2) + ".ts");
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

for (const envFile of [".env.local", ".env"]) {
  const envPath = path.join(__dirname, "..", envFile);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  }
}

function refreshCookieValue(res) {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const m = setCookie.match(/(?:^|,\s*)md_rt=([^;]*)/);
  return m ? m[1] : null;
}

function decodeJwtExp(token) {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp;
}

// The returning-user bug: a persisted access token outlives its 60-minute life
// while the UI still looks signed in, and every authed route 401s until the
// user manually disconnects. The fix is that login hands back a Cognito refresh
// token in an httpOnly cookie which /api/auth/refresh can trade for a new
// access token without the user re-signing anything.
test("session: login issues a refresh cookie that mints a fresh access token", async (t) => {
  if (!process.env.COGNITO_USER_POOL_ID || !process.env.COGNITO_CLIENT_ID || !hasAwsCredentials()) {
    t.skip("Missing Cognito config or AWS credentials");
    return;
  }

  const { POST: login } = await import("../app/api/auth/email/login/route.ts");
  const { POST: refresh } = await import("../app/api/auth/refresh/route.ts");
  const { NextRequest } = await import("next/server.js");
  const {
    CognitoIdentityProviderClient,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
    AdminDeleteUserCommand,
  } = require("@aws-sdk/client-cognito-identity-provider");

  const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const username = `refresh_test_${Date.now()}`;
  const email = `${username}@example.com`;
  const password = "TestPass123!";

  await client.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
    })
  );
  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: username,
      Password: password,
      Permanent: true,
    })
  );

  try {
    const loginRes = await login(
      new Request("http://localhost/api/auth/email/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
    );
    assert.strictEqual(loginRes.status, 200);
    const { accessToken: firstToken } = await loginRes.json();

    const setCookie = loginRes.headers.get("set-cookie");
    assert.ok(setCookie, "login must set a cookie");
    assert.match(setCookie, /HttpOnly/i, "refresh cookie must be httpOnly — page JS must never read it");
    assert.match(setCookie, /Path=\/api\/auth/i, "refresh cookie should not ride along on non-auth requests");

    const refreshToken = refreshCookieValue(loginRes);
    assert.ok(refreshToken, "login must return a Cognito refresh token in the md_rt cookie");

    // The returning-user path: browser has only the cookie, no live access token.
    const refreshed = await refresh(
      new NextRequest("http://localhost/api/auth/refresh", {
        method: "POST",
        headers: { cookie: `md_rt=${refreshToken}` },
      })
    );
    assert.strictEqual(refreshed.status, 200, "a valid refresh cookie must mint a new access token");
    const { accessToken: secondToken } = await refreshed.json();
    assert.ok(secondToken, "expected a renewed access token");
    assert.strictEqual(secondToken.split(".").length, 3, "renewed token should be a JWT");
    assert.ok(
      decodeJwtExp(secondToken) >= decodeJwtExp(firstToken),
      "renewed token must not expire before the one it replaces"
    );
  } finally {
    await client.send(
      new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username })
    );
  }
});

// A dead refresh token has to end the session cleanly. If it 500s or returns
// 200 with nothing, the client can't tell "renew failed" from "signed out" and
// lands back in the silent-stale-session state this fix exists to remove.
test("session: a missing or dead refresh cookie signs the user out", async (t) => {
  if (!process.env.COGNITO_USER_POOL_ID || !process.env.COGNITO_CLIENT_ID || !hasAwsCredentials()) {
    t.skip("Missing Cognito config or AWS credentials");
    return;
  }

  const { POST: refresh } = await import("../app/api/auth/refresh/route.ts");
  const { NextRequest } = await import("next/server.js");

  const noCookie = await refresh(
    new NextRequest("http://localhost/api/auth/refresh", { method: "POST" })
  );
  assert.strictEqual(noCookie.status, 401, "no refresh cookie means signed out");

  const badCookie = await refresh(
    new NextRequest("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: "md_rt=not-a-real-refresh-token" },
    })
  );
  assert.strictEqual(badCookie.status, 401, "a rejected refresh token means signed out");
  const cleared = badCookie.headers.get("set-cookie");
  assert.ok(cleared, "a dead session must clear the cookie");
  assert.match(cleared, /md_rt=;/, "cookie value should be emptied");
  assert.match(cleared, /Max-Age=0/i, "cookie should be expired immediately");
});

// Signing out has to drop the cookie, otherwise the next page load can mint a
// brand new access token for someone who just signed out.
test("session: logout clears the refresh cookie", async () => {
  const { POST: logout } = await import("../app/api/auth/logout/route.ts");

  const res = await logout();
  assert.strictEqual(res.status, 200);
  const cleared = res.headers.get("set-cookie");
  assert.ok(cleared, "logout must send a cookie-clearing header");
  assert.match(cleared, /md_rt=;/);
  assert.match(cleared, /Max-Age=0/i);
  assert.match(cleared, /HttpOnly/i);
});
