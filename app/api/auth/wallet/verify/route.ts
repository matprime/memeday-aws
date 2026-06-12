import { createHmac, createPublicKey, verify as cryptoVerify } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const NONCE_TTL_MS = 5 * 60 * 1000;
const OFFCHAIN_SIGNING_DOMAIN = Buffer.concat([Buffer.from([0xff]), Buffer.from("solana offchain")]);

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

function verifyChallenge(challenge: string, walletAddress: string): boolean {
  const dotIdx = challenge.lastIndexOf(".");
  if (dotIdx < 0) return false;
  const nonce = challenge.slice(0, dotIdx);
  const claimedHmac = challenge.slice(dotIdx + 1);
  const expectedHmac = createHmac("sha256", getEnv("WALLET_AUTH_SECRET")).update(nonce).digest("hex");
  if (expectedHmac !== claimedHmac) return false;
  const parts = nonce.split(":");
  if (parts.length < 3) return false;
  const ts = parseInt(parts[0], 10);
  if (Date.now() - ts > NONCE_TTL_MS) return false;
  if (parts[1] !== walletAddress) return false;
  return true;
}

// Ledger devices refuse to sign raw bytes: the wallet wraps the message in the
// Solana off-chain message envelope and the device signs that instead. Build
// both the Anza v0 envelope (zeroed application domain, single signer — what
// wallet-adapter/Phantom construct) and the older legacy variant without the
// app-domain/signer fields.
function offchainEnvelopes(msg: Buffer, pubkeyRaw: Buffer): Buffer[] {
  const len = Buffer.alloc(2);
  len.writeUInt16LE(msg.length);
  const envelopes: Buffer[] = [];
  for (const format of [0, 1]) {
    envelopes.push(
      Buffer.concat([
        OFFCHAIN_SIGNING_DOMAIN,
        Buffer.from([0]), // header version
        Buffer.alloc(32), // application domain
        Buffer.from([format]),
        Buffer.from([1]), // signer count
        pubkeyRaw,
        len,
        msg,
      ])
    );
    envelopes.push(
      Buffer.concat([OFFCHAIN_SIGNING_DOMAIN, Buffer.from([0]), Buffer.from([format]), len, msg])
    );
  }
  return envelopes;
}

function verifySolanaSignature(message: string, signatureB64: string, walletAddress: string): boolean {
  try {
    // bs58 decode the Solana public key (32 bytes) then wrap in ed25519 DER
    const bs58 = require("bs58").default ?? require("bs58");
    const pubkeyRaw = Buffer.from(bs58.decode(walletAddress));
    const derKey = Buffer.concat([DER_PREFIX, pubkeyRaw]);
    const pubkey = createPublicKey({ key: derKey, format: "der", type: "spki" });
    const sig = Buffer.from(signatureB64, "base64");
    const msg = Buffer.from(message, "utf8");
    const candidates = [msg, ...offchainEnvelopes(msg, pubkeyRaw)];
    return candidates.some((candidate) => cryptoVerify(null, candidate, pubkey, sig));
  } catch {
    return false;
  }
}

async function ensureCognitoUser(walletAddress: string) {
  const client = cognitoClient();
  const userPoolId = getEnv("COGNITO_USER_POOL_ID");
  const username = `wallet_${walletAddress}`;
  const password = derivePassword(walletAddress);

  try {
    await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
  } catch (err: any) {
    if (err.name !== "UserNotFoundException") throw err;
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

  return { username, password };
}

export async function POST(req: NextRequest) {
  const { walletAddress, challenge, signature } = await req.json();

  if (!walletAddress || !challenge || !signature) {
    return NextResponse.json({ error: "walletAddress, challenge, and signature required" }, { status: 400 });
  }

  if (!verifyChallenge(challenge, walletAddress)) {
    return NextResponse.json({ error: "Invalid or expired challenge" }, { status: 401 });
  }

  if (!verifySolanaSignature(challenge, signature, walletAddress)) {
    return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
  }

  try {
    const { username, password } = await ensureCognitoUser(walletAddress);
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

    return NextResponse.json({
      accessToken: tokens.AccessToken,
      expiresIn: tokens.ExpiresIn,
    });
  } catch (err: any) {
    console.error("Wallet auth error:", err);
    return NextResponse.json({ error: "Authentication failed" }, { status: 500 });
  }
}
