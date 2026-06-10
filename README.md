# MemeDay

Memes become assets. Creators become founders. Fans become co-owners.

MemeDay is a Solana-based meme platform built as a creator economy flywheel. Creators post memes and receive SOL tips instantly via Solana Pay. Fans earn platform tokens through engagement. Creators launch individual meme tokens via the Bags SDK. Viral memes become NFTs via Metaplex.

Built with Next.js 14, AWS, and the Solana wallet ecosystem.

## What works today

- Meme upload, browsing, and voting
- Comments with Supabase persistence
- Solana wallet connection (Phantom)
- Solana Pay QR tipping: scan to send SOL directly to the creator's wallet
- Creator leaderboard and trending tokens page
- Daily featured meme

## In development

- Creator token launch via Bags SDK (UI in place, on-chain transaction next)
- NFT minting via Metaplex (UI in place, on-chain transaction next)
- Platform engagement token with 30-day vesting

## Tech stack

Next.js 14 (App Router), TypeScript, Tailwind CSS, AWS (DynamoDB + S3), @solana/web3.js, Solana Wallet Adapter, Solana Pay, Bags SDK, Metaplex, Zustand

## AWS Setup

This will create table MemeDay in AWS DynamoDB
1. In AWS Create IAM user `memeday-deploy`
2. Attach to user policies directly: PowerUserAccess, IAMFullAccess 
3. Generate access keys and add to `.env
4. cd infra & npm run bootstrap & npm run dev

## Setup

Requires Node.js 22 LTS.

npm install

cp .env.example .env

Fill in .env:
AWS_ACCESS_KEY_ID:             Your AWS access key
AWS_SECRET_ACCESS_KEY:         Your AWS access key secret
AWS_REGION:                    Your AWS region

DYNAMODB_TABLE_NAME=MemeDay    Your app's single table name




npm run dev

Open http://localhost:3000

## CI

GitHub Actions workflow runs unit tests on push. See .github/workflows/ci.yml.
