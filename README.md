# MemeDay

Memes become assets. Creators become founders. Fans become co-owners.

MemeDay reimagines social engagement as an earning event. Every like, comment, and share generates real value — creators receive tips instantly, earn platform tokens through reach, launch their own creator tokens, and mint viral content as NFTs.

Architected for production scale: single-table DynamoDB with three sparse GSIs, Cognito auth with wallet support, and S3 media with presigned uploads (CloudFront planned). Deployed on Vercel with Next.js 14.

The flywheel: engagement drives value, value drives engagement.

## What works today

- Meme upload, browsing, and voting
- Comments with DynamoDB persistence
- Cognito auth: email sign-up + wallet sign-in (signature verified server-side, Cognito-issued session)
- Creator leaderboard and trending tokens page
- Daily featured meme
- Solana wallet connection (Phantom)
- Solana Pay QR tipping: scan to send SOL directly to the creator's wallet
- Streams-driven materialized views for trending and leaderboard (DynamoDB Streams -> Lambda)
- On-chain NFT minting via Metaplex on Solana devnet

## In development

- Creator token launch via Bags SDK (mocked; mainnet, post-deadline)
- Platform engagement token with 30-day vesting

## Tech stack

AWS CDK, Amazon DynamoDB, AWS Lambda, Amazon S3, Amazon Cognito, Vercel, v0, Next.js 14 (app router), React, TypeScript, Tailwind CSS, Zustand, lucide-react, qrcode.react, @solana/web3.js, Solana Wallet Adapter, Solana Pay, Metaplex

## AWS infrastructure

Provisioned via CDK (`infra/lib/memeday-stack.ts`):

- **DynamoDB** — single-table design, three sparse GSIs (email, wallet, listing)
- Cognito User Pool — email auth; wallet sign-in via API-route signature verify + Cognito admin auth
- Lambda (StreamHandler) — DynamoDB Streams consumer maintaining trending/leaderboard views

```bash
cd infra
npm install
npm run bootstrap   # once per AWS account/region
npm run deploy
```

## Setup

Requires Node.js 22 LTS.

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

```
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=eu-west-1

DYNAMODB_TABLE_NAME=MemeDay

COGNITO_USER_POOL_ID=        # from cdk deploy output: UserPoolId
COGNITO_CLIENT_ID=           # from cdk deploy output: UserPoolClientId
WALLET_AUTH_SECRET=          # openssl rand -hex 32

S3_BUCKET_NAME=
CLOUDFRONT_DOMAIN=           # without https://

NEXT_PUBLIC_APP_URL=         # e.g. https://your-app.vercel.app
```

```bash
npm run dev
# Open http://localhost:3000
```

## CI

GitHub Actions runs unit tests on every push. See `.github/workflows/ci.yml`.
