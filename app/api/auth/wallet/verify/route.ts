import { createHmac } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getClientIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { setRefreshCookie } from "@/lib/auth-cookie";
import { verifyChallenge, verifySolanaSignature } from "@/lib/wallet-signature";

function cognitoClient() {
  return new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? "us-east-1" });
}

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} not set`);
  return v;
}

// Derive a deterministic server-side password for wallet users so we can use
// ADMIN_USER_PASSWORD_AUTH without Lambda triggers.
function derivePassword(walletAddress: string): string {
  // Suffix guarantees upper/lower/digit/symbol so the derived password always
  // satisfies the pool password policy regardless of the hash's characters.
  return (
    createHmac("sha256", getEnv("WALLET_AUTH_SECRET"))
      .update(`pwd:${walletAddress}`)
      .digest("base64url") + "Aa1!"
  );
}

async function ensureCognitoUser(walletAddress: string) {
  const client = cognitoClient();
  const userPoolId = getEnv("COGNITO_USER_POOL_ID");
  const username = `wallet_${walletAddress}`;
  const password = derivePassword(walletAddress);

  let isNewUser = false;

  try {
    await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
  } catch (err: any) {
    if (err.name !== "UserNotFoundException") throw err;
    isNewUser = true;
    // First login — create user with permanent password, suppress Cognito welcome email
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: username,
        TemporaryPassword: password,
        MessageAction: "SUPPRESS",
        UserAttributes: [{ Name: "custom:walletAddr", Value: walletAddress }],
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
  }

  return { username, password, isNewUser };
}

export async function POST(req: NextRequest) {
  const { walletAddress, challenge, signature } = await req.json();

  if (!walletAddress || !challenge || !signature) {
    return NextResponse.json({ error: "walletAddress, challenge, and signature required" }, { status: 400 });
  }

  if (await isRateLimited("walletVerifyPerIp", getClientIp(req))) {
    return rateLimitResponse();
  }

  if (!verifyChallenge(challenge, walletAddress)) {
    return NextResponse.json({ error: "Invalid or expired challenge" }, { status: 401 });
  }

  if (!verifySolanaSignature(challenge, signature, walletAddress)) {
    return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
  }

  try {
    const { username, password, isNewUser } = await ensureCognitoUser(walletAddress);
    const client = cognitoClient();

    const result = await client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: getEnv("COGNITO_USER_POOL_ID"),
        ClientId: getEnv("COGNITO_CLIENT_ID"),
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: username, PASSWORD: password },
      })
    );

    const tokens = result.AuthenticationResult;
    if (!tokens?.AccessToken) {
      return NextResponse.json({ error: "Auth failed — no token returned" }, { status: 500 });
    }

    const res = NextResponse.json({
      accessToken: tokens.AccessToken,
      expiresIn: tokens.ExpiresIn,
      // Lets the client tell a first-ever wallet sign-up apart from a return
      // login, which is otherwise indistinguishable — both just get a token.
      isNewUser,
    });
    // The refresh token never reaches page JS — it goes back as an httpOnly
    // cookie that only /api/auth/refresh reads.
    if (tokens.RefreshToken) setRefreshCookie(res, tokens.RefreshToken);
    return res;
  } catch (err: any) {
    console.error("Wallet auth error:", err);
    return NextResponse.json({ error: "Authentication failed" }, { status: 500 });
  }
}
