# MemeDay Architecture (v11)

Reference for Claude Code. Derived from `memeday_architecture_v11.svg` and
`memeday_dynamodb_single_table.svg`.
DynamoDB single-table primary store, Vercel + Lambda hybrid compute,
S3/CloudFront media, Streams-driven materialized views, Cognito identity
provider with wallet custom-auth, Bags.fm mocked.

## Layers

### Frontend : Vercel / v0.app
Next.js, React, Tailwind, shadcn/ui. Wallet connect via Phantom / Solflare.

### Compute : hybrid
- Vercel serverless (Next.js API routes) handle synchronous work:
  auth callbacks, CRUD, feed reads, voting, and issuing S3 presigned URLs.
- AWS Lambda handles events and privileged work:
  triggered by DynamoDB Streams, EventBridge cron, and S3 events.
  Also performs server-side on-chain signing for platform actions.

### Data : Amazon DynamoDB (single-table primary store)
Single table `MemeDay`, Global Tables enabled (multi-region active-active),
Streams enabled. See "Single-table data model" below for the full schema.

### Media : Amazon S3 + CloudFront
- S3 is a private bucket holding meme images and NFT metadata JSON.
- CloudFront (Origin Access Control) is the only public path to S3.
- Clients upload directly to S3 via presigned URLs, bypassing Vercel.

### Auth : Amazon Cognito (identity provider)
- Cognito is the only identity system. `userId` is the Cognito `sub`.
- Sign-up requires at least one of email OR wallet (either alone is valid);
  the other can be linked later.
- Email login is standard Cognito.
- Wallet login is a Cognito custom-auth challenge: client signs a nonce,
  Cognito verifies the signature, then issues the session (JWT).
- There is no separate or parallel wallet/JWT session system alongside
  Cognito.
- `EMAIL#` and `WALLET#` lookups are sparse GSI entries (see GSI1 / GSI2).

### On-chain : Solana
- Solana devnet (live demo): NFT mints via Metaplex, Solana Pay tips.
- Bags.fm: MOCKED (simulated SDK). Mainnet, post-deadline only. The single
  simulated link in the diagram.

## Single-table data model

Base table `MemeDay`. `PK` = partition key, `SK` = sort key. All entities are
modeled as item types on one table. Rows sharing `PK = MEME#<memeId>` form one
item collection (a meme's metadata, comments, likes, listing, and sale history)
retrievable in a single query.

| Entity    | PK                | SK                        | Key attributes |
|-----------|-------------------|---------------------------|----------------|
| User      | `USER#<userId>`   | `USER#<userId>`           | `email?`, `walletAddr?`, `displayName`, `authMethods` (userId = Cognito sub; need >=1 of email/wallet) |
| Meme      | `MEME#<memeId>`   | `MEME#<memeId>`           | `creatorId`* , `ownerId`+ , `s3Key`, `nftMint`, `status`, `likeCount`, `commentCount`, `score` |
| Comment   | `MEME#<memeId>`   | `COMMENT#<ts>#<id>`       | `userId`, `body` |
| Like      | `MEME#<memeId>`   | `LIKE#<userId>`           | `createdAt` (one item per user = dedupe) |
| Ownership | `MEME#<memeId>`   | `OWNERSHIP#<ts>#<txSig>`  | `fromUserId`, `toUserId`, `priceSol`, `txSig` |
| Listing   | `MEME#<memeId>`   | `LISTING#ACTIVE`          | `priceSol` (owner-set, mutable), `listedAt` |
| Feed item | `FEED#GLOBAL`     | `<score>#<memeId>`        | snapshot: `creator`, `s3Key`, `score` (written by Streams to Lambda) |

\* `creatorId` is fixed.  + `ownerId` changes on sale.

### Global secondary indexes (overloaded)

| Index | GSI PK | GSI SK | Serves |
|-------|--------|--------|--------|
| GSI1 relations | `USER#<creatorId>` | `MEME#<createdAt>` | Memes created by a user (creator profile). Also: `EMAIL#` to login (sparse); `USER#` to a user's likes. |
| GSI2 ownership | `OWNER#<ownerId>` | `MEME#<acquiredAt>` | Memes a user currently owns (re-pointed on sale). Also: `WALLET#<addr>` to user by wallet (sparse). |
| GSI3 discovery | `FEED#GLOBAL` / `MARKET#LISTED` | `<createdAt>` / `<priceSol>` | Newest global feed; browse memes listed for sale (sorted by zero-padded price). |

### Served on the base table (no GSI)
- Comments: `SK begins_with COMMENT#`
- Sale history: `SK begins_with OWNERSHIP#`
- "Did user like?": `GetItem` on `LIKE#<userId>`

### NFT resale : ownership transfer and pricing
- `ownerId` is mutable and is set or changed only by the current owner, via
  `UpdateItem` with `ConditionExpression ownerId = :caller`. Non-owners
  (including the original creator) fail at the DB.
- For-sale browsing uses GSI3 `MARKET#LISTED` sorted by price. Zero-pad
  `priceSol` in the SK so ordering is correct.
- A sale is a single `TransactWriteItems`: write the `OWNERSHIP#<ts>` record,
  re-point the meme's `ownerId` and GSI2 PK to `OWNER#<buyer>`, and clear the
  active listing. This means a price change cannot be raced. The on-chain
  Metaplex transfer is reconciled after confirmation.

## Data flow rules (directives)
- Feed reads, voting, CRUD, and auth callbacks go through Vercel API routes.
- Stream/cron/S3-triggered and on-chain-signing work goes through Lambda.
- Trending / Leaderboard / Daily featured are served from materialized
  views (Streams to Lambda), never computed live from base items.
- Media uploads go client to S3 (presigned), not client to Vercel to S3.
- Media reads go through CloudFront, never directly from the S3 bucket.
- `userId` is the Cognito `sub`; do not generate user IDs elsewhere.
- Wallet login is a Cognito custom-auth challenge; do not build a parallel
  session/JWT system alongside Cognito.
- Ownership and listing changes are owner-gated at the DB via
  `ConditionExpression`; never bypass that check in application code.
- User on-chain actions are signed client-side; platform on-chain actions
  are signed server-side in Lambda.
- Bags.fm is mocked. Do not wire real mainnet calls without explicit approval.
