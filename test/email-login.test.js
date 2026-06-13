const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");

// The route imports "next/server", which only resolves as "next/server.js"
// under Node's ESM resolution (same trick as the voting test's next/cache stub).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    return nextResolve(specifier, context);
  },
});

// Load .env so the Cognito client gets pool id, client id, and credentials.
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

test("email auth: sign-in with email returns a Cognito token", async (t) => {
  if (!process.env.COGNITO_USER_POOL_ID || !process.env.COGNITO_CLIENT_ID || !process.env.AWS_ACCESS_KEY_ID) {
    t.skip("Missing Cognito config or AWS credentials");
    return;
  }

  const { POST: login } = await import("../app/api/auth/email/login/route.ts");
  const {
    CognitoIdentityProviderClient,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
    AdminDeleteUserCommand,
  } = require("@aws-sdk/client-cognito-identity-provider");

  const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const username = `email_test_${Date.now()}`;
  const email = `${username}@example.com`;
  const password = "TestPass123!";

  // Confirmed user with a verified email — the state a user is in after
  // completing the signup + confirmation-code flow.
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

  const loginRequest = (body) =>
    login(
      new Request("http://localhost/api/auth/email/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );

  try {
    const ok = await loginRequest({ email, password });
    assert.strictEqual(ok.status, 200, "login with correct password should succeed");
    const { accessToken } = await ok.json();
    assert.ok(accessToken, "expected a Cognito access token");
    // Cognito access tokens are JWTs (three dot-separated segments)
    assert.strictEqual(accessToken.split(".").length, 3, "token should be a JWT");

    const bad = await loginRequest({ email, password: "WrongPass123!" });
    assert.strictEqual(bad.status, 401, "wrong password should be rejected");
  } finally {
    await client.send(
      new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username })
    );
  }
});
