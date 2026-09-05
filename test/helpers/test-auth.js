const { generateKeyPairSync, sign: cryptoSign } = require("crypto");

const DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Builds a real ed25519 keypair with the same DER/bs58 shape a Solana wallet
// uses, so tests can sign a wallet-auth challenge without a browser wallet.
// Verified against lib/wallet-signature.ts's own verifySolanaSignature.
function generateTestWallet() {
  const bs58 = require("bs58").default ?? require("bs58");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPub = spki.subarray(spki.length - 32);
  return { privateKey, walletAddress: bs58.encode(rawPub) };
}

function signChallenge(privateKey, challenge) {
  return cryptoSign(null, Buffer.from(challenge, "utf8"), privateKey).toString("base64");
}

// Reads `sub` out of a Cognito JWT without verifying — only used so tests
// know which DynamoDB/rate-limit keys to clean up, never as an auth check.
function decodeJwtSub(accessToken) {
  const payload = accessToken.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).sub;
}

// Creates a real Cognito user under the given username and returns a live
// access token for it, the same ADMIN_USER_PASSWORD_AUTH flow the app's own
// wallet login uses (app/api/auth/wallet/verify/route.ts). Passing a
// "wallet_<address>" username makes the session wallet-authenticated per
// lib/cognito.ts getWalletAddressFromRequest; any other username makes it an
// ordinary (email-style) session with no wallet signal on the token.
async function createTestCognitoSession(username) {
  const {
    CognitoIdentityProviderClient,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
    AdminInitiateAuthCommand,
    AdminDeleteUserCommand,
  } = require("@aws-sdk/client-cognito-identity-provider");

  const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const password = "TestPass123!Aa";

  await client.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      MessageAction: "SUPPRESS",
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
  const result = await client.send(
    new AdminInitiateAuthCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: username, PASSWORD: password },
    })
  );
  const accessToken = result.AuthenticationResult.AccessToken;
  const userId = decodeJwtSub(accessToken);

  const cleanup = async () => {
    await client
      .send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }))
      .catch(() => {});
  };

  return { accessToken, userId, cleanup };
}

module.exports = { generateTestWallet, signChallenge, createTestCognitoSession, decodeJwtSub };
