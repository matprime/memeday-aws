const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { hasAwsCredentials } = require("./helpers/aws-credentials");

// The route imports "next/server", which only resolves as "next/server.js"
// under Node's ESM resolution (same trick as the voting test's next/cache stub).
// It also imports lib/rate-limit.ts via the "@/" tsconfig path alias, and
// rate-limit.ts in turn does extensionless relative imports (e.g. "./dynamo")
// — neither resolves under plain Node ESM, so both get resolved to the repo
// file directly (same idea as the extensionless-relative-import trick in
// voting-enforcement.test.js).
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

// Load .env so the Cognito client gets pool id, client id, and credentials.
// .env.local overrides .env, same precedence Next.js uses — dev pool/client ids live there.
for (const envFile of [".env.local", ".env"]) {
  const envPath = path.join(__dirname, "..", envFile);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  }
}

test("email auth: sign-in with email returns a Cognito token", async (t) => {
  if (!process.env.COGNITO_USER_POOL_ID || !process.env.COGNITO_CLIENT_ID || !hasAwsCredentials()) {
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
        headers: {
          "Content-Type": "application/json",
          // Without this, getClientIp() falls back to the literal string
          // "unknown", and loginPerIp (max 10 / 15min) becomes a single
          // shared DynamoDB counter across every CI run and test file that
          // hits this route in the same window. A unique value per test run
          // gives this test its own isolated bucket. See KAN-70.
          "x-forwarded-for": `test-email-login-${Date.now()}`,
        },
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
