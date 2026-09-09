import { CognitoJwtVerifier } from "aws-jwt-verify";

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  if (!verifier) {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID;
    if (!userPoolId || !clientId) {
      throw new Error("Missing COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID");
    }
    verifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: "access",
      clientId,
    });
  }
  return verifier;
}

export async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  try {
    const payload = await getVerifier().verify(token);
    return payload.sub;
  } catch {
    return null;
  }
}

// cognito:groups is a standard claim Cognito adds to the access token for any
// user in at least one group (KAN-43 admin gate) — no auth flow change needed,
// just reading a claim the verifier already had.
export async function getUserGroupsFromRequest(req: Request): Promise<string[]> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return [];
  const token = auth.slice(7);
  try {
    const payload = await getVerifier().verify(token);
    return payload["cognito:groups"] ?? [];
  } catch {
    return [];
  }
}

const WALLET_USERNAME_PREFIX = "wallet_";

// The access token's username claim gets the "wallet_" prefix only in
// ensureCognitoUser (app/api/auth/wallet/verify/route.ts), and only after the
// ed25519 signature over the HMAC challenge has been verified. That makes the
// prefix a server-verified signal, unlike user.walletAddr in DynamoDB, which
// is client-asserted (KAN-75). The access token carries no custom:walletAddr
// claim, so the username is the only proof available at request time.
export async function getWalletAddressFromRequest(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  try {
    const payload = await getVerifier().verify(token);
    const username = payload.username;
    if (typeof username === "string" && username.startsWith(WALLET_USERNAME_PREFIX)) {
      return username.slice(WALLET_USERNAME_PREFIX.length);
    }
    return null;
  } catch {
    return null;
  }
}
