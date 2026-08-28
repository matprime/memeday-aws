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
