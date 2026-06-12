import { NextRequest, NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  ListUsersCommand,
  ResendConfirmationCodeCommand,
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
    // Same admin flow as wallet login; email works as USERNAME because it is
    // a verified sign-in alias.
    const result = await client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: getEnv("COGNITO_USER_POOL_ID"),
        ClientId: getEnv("COGNITO_CLIENT_ID"),
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })
    );

    const tokens = result.AuthenticationResult;
    if (!tokens?.AccessToken) {
      return NextResponse.json({ error: "Auth failed — no token returned" }, { status: 500 });
    }

    return NextResponse.json({
      accessToken: tokens.AccessToken,
      expiresIn: tokens.ExpiresIn,
    });
  } catch (err: any) {
    if (err.name === "NotAuthorizedException") {
      return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
    }
    if (err.name === "UserNotFoundException" || err.name === "UserNotConfirmedException") {
      // An unverified email alias doesn't resolve, so unconfirmed users land
      // here as UserNotFoundException. Look the user up so the client can
      // re-enter the confirmation flow with a fresh code.
      const users = await client.send(
        new ListUsersCommand({
          UserPoolId: getEnv("COGNITO_USER_POOL_ID"),
          Filter: `email = "${email.replace(/"/g, "")}"`,
          Limit: 1,
        })
      );
      const user = users.Users?.[0];
      if (user?.Username && user.UserStatus === "UNCONFIRMED") {
        await client.send(
          new ResendConfirmationCodeCommand({
            ClientId: getEnv("COGNITO_CLIENT_ID"),
            Username: user.Username,
          })
        );
        return NextResponse.json(
          { error: "Email not verified — code resent", needsConfirmation: true, username: user.Username },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
    }
    console.error("Email login error:", err);
    return NextResponse.json({ error: "Authentication failed" }, { status: 500 });
  }
}
