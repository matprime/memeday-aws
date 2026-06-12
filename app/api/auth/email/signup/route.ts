import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";

function cognitoClient() {
  return new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? "us-east-1" });
}

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} not set`);
  return v;
}

export async function POST(req: NextRequest) {
  const { email, password } = await req.json();

  if (!email || !password) {
    return NextResponse.json({ error: "email and password required" }, { status: 400 });
  }

  const client = cognitoClient();

  try {
    // Email is a Cognito alias, so duplicates only surface at confirm time
    // (AliasExistsException). Check up front for a sane error instead.
    const existing = await client.send(
      new ListUsersCommand({
        UserPoolId: getEnv("COGNITO_USER_POOL_ID"),
        Filter: `email = "${email.replace(/"/g, "")}"`,
        Limit: 1,
      })
    );
    if (existing.Users && existing.Users.length > 0) {
      return NextResponse.json({ error: "This email is already registered" }, { status: 409 });
    }

    // Email can't be the username (it's a sign-in alias) — use an opaque one,
    // mirroring wallet_<addr> for wallet users. Cognito emails the
    // verification code (autoVerify email).
    const username = `email_${randomUUID()}`;
    await client.send(
      new SignUpCommand({
        ClientId: getEnv("COGNITO_CLIENT_ID"),
        Username: username,
        Password: password,
        UserAttributes: [{ Name: "email", Value: email }],
      })
    );

    return NextResponse.json({ username });
  } catch (err: any) {
    if (err.name === "InvalidPasswordException" || err.name === "InvalidParameterException") {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Email signup error:", err);
    return NextResponse.json({ error: "Sign-up failed" }, { status: 500 });
  }
}
