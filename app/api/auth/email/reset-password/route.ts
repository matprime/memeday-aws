import { NextRequest, NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ListUsersCommand,
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
  const { email, code, newPassword } = await req.json();
  if (!email || !code || !newPassword) {
    return NextResponse.json({ error: "email, code, and newPassword required" }, { status: 400 });
  }

  try {
    // Email is a Cognito alias (username is email_<uuid>). ConfirmForgotPassword
    // doesn't reliably resolve aliases — look up the canonical username first.
    const users = await cognitoClient().send(
      new ListUsersCommand({
        UserPoolId: getEnv("COGNITO_USER_POOL_ID"),
        Filter: `email = "${email.replace(/"/g, "")}"`,
        Limit: 1,
      })
    );
    const username = users.Users?.[0]?.Username ?? email;

    await cognitoClient().send(
      new ConfirmForgotPasswordCommand({
        ClientId: getEnv("COGNITO_CLIENT_ID"),
        Username: username,
        ConfirmationCode: code.trim(),
        Password: newPassword,
      })
    );
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    if (err.name === "CodeMismatchException" || err.name === "ExpiredCodeException") {
      return NextResponse.json({ error: "Invalid or expired reset code" }, { status: 400 });
    }
    if (err.name === "InvalidPasswordException") {
      return NextResponse.json({ error: err.message ?? "Password does not meet requirements" }, { status: 400 });
    }
    console.error("Reset password error:", err);
    return NextResponse.json({ error: "Failed to reset password" }, { status: 500 });
  }
}
