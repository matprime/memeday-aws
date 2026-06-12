import { NextRequest, NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
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
  const { username, code } = await req.json();

  if (!username || !code) {
    return NextResponse.json({ error: "username and code required" }, { status: 400 });
  }

  try {
    await cognitoClient().send(
      new ConfirmSignUpCommand({
        ClientId: getEnv("COGNITO_CLIENT_ID"),
        Username: username,
        ConfirmationCode: code,
      })
    );
    return NextResponse.json({ confirmed: true });
  } catch (err: any) {
    if (err.name === "CodeMismatchException" || err.name === "ExpiredCodeException") {
      return NextResponse.json({ error: "Invalid or expired code" }, { status: 400 });
    }
    if (err.name === "AliasExistsException") {
      return NextResponse.json({ error: "This email is already registered" }, { status: 409 });
    }
    console.error("Email confirm error:", err);
    return NextResponse.json({ error: "Confirmation failed" }, { status: 500 });
  }
}
