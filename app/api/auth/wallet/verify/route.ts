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
import { upsertUser } from "@/lib/db";

function cognitoClient() {
  return new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? "us-east-1" });
}

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} not set`);
  return v;
}

// Reads sub out of the access token this request just minted via
// AdminInitiateAuthCommand. Not a signature check: we trust it because we
// issued it ourselves moments earlier in this same request, the same way
// lib/store.ts's client-side decodeJwtSub trusts a token already accepted
// elsewhere.
function decodeSub(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).sub;
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

    // Re-links and re-proves the address on every successful wallet login
    // (KAN-75), since reaching this line already means verifyChallenge and
    // verifySolanaSignature both passed. Wrapped so a DynamoDB hiccup never
    // blocks a login the Cognito side already granted; the same stamp also
    // happens lazily on the next POST /api/users call from this session, so
    // a failure here is not the only chance to catch up.
    try {
      await upsertUser({ userId: decodeSub(tokens.AccessToken), walletAddr: walletAddress, walletVerified: true });
    } catch (err) {
      console.error("Failed to stamp walletVerifiedAt on wallet login:", err);
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
