import { NextRequest, NextResponse } from "next/server";
import { CognitoIdentityProviderClient, ForgotPasswordCommand } from "@aws-sdk/client-cognito-identity-provider";

function cognitoClient() {
  return new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? "us-east-1" });
}

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} not set`);
  return v;
}

export async function POST(req: NextRequest) {
  const { email } = await req.json();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  try {
    await cognitoClient().send(
      new ForgotPasswordCommand({ ClientId: getEnv("COGNITO_CLIENT_ID"), Username: email })
    );
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    if (err.name === "UserNotFoundException") {
      // Don't reveal whether the email exists
      return NextResponse.json({ ok: true });
    }
    console.error("Forgot password error:", err);
    return NextResponse.json({ error: "Failed to send reset code" }, { status: 500 });
  }
}
