# MemeDay Architecture (v11)

Reference for Claude Code. Derived from `memeday_architecture_v11.svg`.
DynamoDB-primary, Vercel + Lambda hybrid compute, S3/CloudFront media,
Streams-driven materialized views, Cognito auth, Bags.fm mocked.

> NOTE: This diagram shows three discrete tables (Users, Memes, Comments).
> The finalized v11 decision was single-table design with GSIs. Reconcile
> before generating data-access code.

## Layers

### Frontend : Vercel / v0.app
Next.js, React, Tailwind, shadcn/ui. Wallet connect via Phantom / Solflare.

### Compute : hybrid
- Vercel serverless (Next.js API routes) handle synchronous work:
  auth callbacks, CRUD, feed reads, voting, and issuing S3 presigned URLs.
- AWS Lambda handles events and privileged work:
  triggered by DynamoDB Streams, EventBridge cron, and S3 events.
  Also performs server-side on-chain signing for platform actions.

### Data : Amazon DynamoDB (primary store)
- Global Tables enabled (multi-region active-active).
- Tables as drawn:
  - Users : userId, email, walletAddr, authMethod
  - Memes : memeId, creatorId, votes, s3Key, nftMint
  - Comments : commentId, memeId, userId, body, ts
- Streams (CDC) feed Lambda, which writes materialized views:
  Trending, Leaderboard, Daily featured. Pre-computed, read-ready items.

### Media : Amazon S3 + CloudFront
- S3 is a private bucket holding meme images and NFT metadata JSON.
- CloudFront (Origin Access Control) is the only public path to S3.
- Clients upload directly to S3 via presigned URLs, bypassing Vercel.

### Auth
- Amazon Cognito (email): verify, reset, MFA. A post-confirmation Lambda
  writes the new user into the Users table.
- Wallet auth (Phantom / Solflare): sign nonce, verify signature,
  link walletAddr to the user record.

### On-chain : Solana
- Solana devnet (live demo): NFT mints via Metaplex, Solana Pay tips.
- Bags.fm: MOCKED (simulated SDK). Mainnet, post-deadline only. The single
  simulated link in the diagram.

## Data flow rules (directives)
- Feed reads, voting, CRUD, and auth callbacks go through Vercel API routes.
- Stream/cron/S3-triggered and on-chain-signing work goes through Lambda.
- Trending / Leaderboard / Daily featured are served from materialized
  views, never computed live from the base tables.
- Media uploads go client to S3 (presigned), not client to Vercel to S3.
- Media reads go through CloudFront, never directly from the S3 bucket.
- User on-chain actions are signed client-side; platform on-chain actions
  are signed server-side in Lambda.
- Bags.fm is mocked. Do not wire real mainnet calls without explicit approval.
