import { NextRequest, NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { REFRESH_COOKIE, clearRefreshCookie } from "@/lib/auth-cookie";
import { getClientIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} not set`);
  return v;
}

function expiredResponse() {
  const res = NextResponse.json({ error: "Session expired" }, { status: 401 });
  clearRefreshCookie(res);
  return res;
}

// Exchanges the Cognito refresh token for a fresh access token. This is
// Cognito's own REFRESH_TOKEN_AUTH flow, not a second session system — the
// cookie is transport for a Cognito-issued token and nothing else.
export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) {
    return NextResponse.json({ error: "No session" }, { status: 401 });
  }

  if (await isRateLimited("refreshPerIp", getClientIp(req))) {
    return rateLimitResponse();
  }

  try {
    const client = new CognitoIdentityProviderClient({
      region: process.env.AWS_REGION ?? "us-east-1",
    });

    const result = await client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: getEnv("COGNITO_USER_POOL_ID"),
        ClientId: getEnv("COGNITO_CLIENT_ID"),
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      })
    );

    const accessToken = result.AuthenticationResult?.AccessToken;
    if (!accessToken) return expiredResponse();

    // Cognito does not re-issue the refresh token here (rotation is off), so
    // the existing cookie stays as-is.
    return NextResponse.json({
      accessToken,
      expiresIn: result.AuthenticationResult?.ExpiresIn,
    });
  } catch (err: any) {
    // Refresh token expired, revoked, or the user was deleted — a real logout.
    if (err.name === "NotAuthorizedException" || err.name === "UserNotFoundException") {
      return expiredResponse();
    }
    // Anything else is our problem, not a dead session: a 500 tells the client
    // to keep the session and retry rather than sign the user out.
    console.error("Token refresh error:", err);
    return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
  }
}
