import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity } from "@metaplex-foundation/umi";
import { createNft, mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { generateSigner, percentAmount } from "@metaplex-foundation/umi";
import { randomUUID } from "crypto";

const sm = new SecretsManagerClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.TABLE_NAME!;
const SECRET_ARN = process.env.PLATFORM_KEYPAIR_SECRET_ARN!;
const APP_URL = process.env.APP_URL!;
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN ?? "";
const DEVNET_RPC = "https://api.devnet.solana.com";

interface EventDetail {
  memeId: string;
  creatorId: string;
  s3Key: string;
  caption: string;
  date: string;
}

export async function handler(event: { detail: EventDetail }): Promise<void> {
  const { memeId, s3Key, caption, date } = event.detail;

  // Idempotent: already minted for this day
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: "FEATURED#DAILY", SK: date } })
  );
  if (existing.Item?.nftMint) return;

  // Register NFT metadata in DynamoDB so we have an on-chain URI
  const imageUrl = CLOUDFRONT_DOMAIN
    ? `https://${CLOUDFRONT_DOMAIN}/${s3Key}`
    : `${APP_URL}/api/image/${s3Key}`;

  const metaId = randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `NFTMETA#${metaId}`,
        SK: `NFTMETA#${metaId}`,
        nftMetaId: metaId,
        name: `Meme of Day — ${date}`,
        image_url: imageUrl,
        description: `MemeDay daily featured meme: "${caption.slice(0, 80)}"`,
        createdAt: new Date().toISOString(),
      },
    })
  );
  const metadataUri = `${APP_URL}/api/nft-metadata/${metaId}`;

  // Load platform keypair from Secrets Manager (stored as JSON array of 64 bytes)
  const secretResp = await sm.send(
    new GetSecretValueCommand({ SecretId: SECRET_ARN })
  );
  const secretBytes = JSON.parse(secretResp.SecretString!) as number[];

  // Mint on Solana devnet with platform keypair
  const umi = createUmi(DEVNET_RPC).use(mplTokenMetadata());
  const platformKeypair = umi.eddsa.createKeypairFromSecretKey(
    new Uint8Array(secretBytes)
  );
  umi.use(keypairIdentity(platformKeypair));

  const mint = generateSigner(umi);
  await createNft(umi, {
    mint,
    name: `Meme of Day — ${date}`,
    symbol: "MDAY",
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(5),
    isMutable: false,
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

  // Record mint address on the FEATURED#DAILY item
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: "FEATURED#DAILY", SK: date },
      UpdateExpression: "SET nftMint = :mint, metadataUri = :uri",
      ExpressionAttributeValues: {
        ":mint": mint.publicKey.toString(),
        ":uri": metadataUri,
      },
    })
  );
}
