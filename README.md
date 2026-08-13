# MemeDay

Memes are how the Internet talks. They can  move markets, shape elections, and turn unknowns into household names overnight. Yet the people creating that cultural force earn nothing, and the rest of us scroll endlessly to find the right memes to send. The problem:  there's no infrastructure built for how memes actually work. MemeDay is the layer that's missing. Engagement becomes a value event where every like, comment, trade, and tip feeds a creator-fan flywheel. Discovery is built to be frictionless, and the hottest memes on any topic are one click from wherever you're posting next. Your likes are worth something now.

Built for production scale on Amazon DynamoDB (single-table, three sparse GSIs, Streams to Lambda materialized views) and Vercel with Next.js 14. Identity is Amazon Cognito (email or wallet); media is presigned direct-to-S3 (CloudFront planned); NFT minting is live on Solana devnet via Metaplex.

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

- DynamoDB Global Tables for active-active multi-region
- CloudFront (OAC) for media reads; retire the temporary image proxy
- Write-sharded counters + subscription-based live vote updates for viral memes
- S3 event-triggered upload validation (type/size) Lambda
- Isolated on-chain signer in AWS Secrets Manager + idempotent daily commemorative mint
- Nightly cron: lock the daily winner and decay scores so fresh content rises
- Least-privilege runtime IAM scoped to DynamoDB, Cognito, S3
- Social sharing to X, Instagram, TikTok, and others
- Creator token launch via Bags SDK (mocked; mainnet, post-deadline)
- Platform engagement token: earned via logins, votes, referrals; stakeable for a share of trading fees; with vesting and anti-abuse (diminishing per-day returns, wallet-history requirement)
- Token-holder rewards: featured comment placement, creator badges, revenue share scaled by holding
- NFT minting on mainnet (already live on devnet)

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
touch .env.local
```

Env is split in two, both gitignored. `.env.local` overrides `.env` — the precedence
Next.js uses, and the one `test/*.test.js` reproduces.

`.env` — deploy-only, what `infra/` CDK commands read:

```
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=eu-west-1

WALLET_AUTH_SECRET=          # openssl rand -hex 32

# Comma-separated recipients for CloudWatch alarm emails (SNS).
# Empty = topic deployed with no subscriptions (no alerts sent).
ALERT_EMAILS=
```

`.env.local` — per-stack app vars, from the stack outputs
(`aws cloudformation describe-stacks --stack-name MemeDayDev --region eu-west-1`):

```
AWS_REGION=eu-west-1         # repeated: clients default to us-east-1 when unset

DYNAMODB_TABLE_NAME=MemeDayDev   # MemeDayProd is the production table

COGNITO_USER_POOL_ID=        # stack output: UserPoolId
COGNITO_CLIENT_ID=           # stack output: UserPoolClientId

S3_BUCKET_NAME=              # stack output: BucketName
CLOUDFRONT_DOMAIN=           # without https://; blank serves via /api/image/<key>

NEXT_PUBLIC_APP_URL=http://localhost:3000

NEXT_PUBLIC_POSTHOG_KEY=     # blank locally — analytics no-op; see docs/ANALYTICS_EVENTS.md
NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com

SOLANA_NETWORK=devnet                          # devnet | mainnet — see "Solana network config" below
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_ENABLED=true                            # kill switch — true | false
```

Deployments read neither file — set the app vars in the Vercel project settings.
Keeping them out of `.env` means a missing `.env.local` fails loud in `lib/dynamo.ts`
instead of silently reading the wrong stack.

```bash
npm run dev
# Open http://localhost:3000
```

## Solana network config

`lib/solana/network.ts` is the single choke point for Solana network config — every
RPC/mint/tip/wallet code path imports network name, RPC URL, explorer cluster, and the
kill switch from there. It fails loudly at import time (same pattern as
`lib/dynamo.ts`): missing or invalid values throw immediately, there is no default
network and no silent fallback.

| Var | Values | What it does |
|---|---|---|
| `SOLANA_NETWORK` | `devnet` \| `mainnet` | Which Solana cluster the app talks to. Required — no default. |
| `SOLANA_RPC_URL` | any RPC endpoint URL | The RPC endpoint used for that network. Required — no default. |
| `SOLANA_ENABLED` | `true` \| `false` | Kill switch for all on-chain features (tips, mint, resale). `false` shows a "temporarily disabled" message in the tip and mint UI instead of silently no-opping. Required — no default. |

**Mainnet guard.** `SOLANA_NETWORK=mainnet` is only accepted when `VERCEL_ENV=production`
exactly. Any other value — `preview`, `development`, or unset (local dev, CI) — rejects a
mainnet request outright (throws at import) rather than silently downgrading it to
devnet. `VERCEL_ENV` is populated automatically by Vercel; **never set it manually**, in
`.env`, `.env.local`, or Vercel project settings — it's what prevents mainnet from being
accidentally enabled on a Preview deployment.

**Configuring in Vercel:** set `SOLANA_NETWORK`, `SOLANA_RPC_URL`, and `SOLANA_ENABLED`
in the project's Environment Variables settings, scoped per environment:
- **Production** — `SOLANA_NETWORK=mainnet` (once ready), a mainnet `SOLANA_RPC_URL`.
- **Preview** — `SOLANA_NETWORK=devnet`, a devnet `SOLANA_RPC_URL`. Setting `mainnet`
  here fails the build — Preview's `VERCEL_ENV` is never `production`.

**Kill switch.** Flip `SOLANA_ENABLED` to `false` in the Vercel project settings (either
scope) and redeploy — no code change needed. Tips and NFT minting show the disabled
message instead of attempting the on-chain action. Set it back to `true` and redeploy to
re-enable.

## CI

GitHub Actions runs unit tests on every push. See `.github/workflows/ci.yml`.
