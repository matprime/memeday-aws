# MemeDay Architecture

DynamoDB single-table primary store (single-region today; Global Tables
planned), Vercel + Lambda hybrid compute, S3 media behind CloudFront,
Streams-driven materialized views, Cognito identity provider (email +
server-verified wallet sign-in), Bags.fm mocked.

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
Single table `MemeDay`, single-region today. Global Tables (multi-region
active-active) are planned but NOT yet deployed; the single-table design is
built to drop into them without remodeling. Streams enabled. See "Single-table
data model" below for the full schema.

### Media : Amazon S3 + CloudFront
- S3 is a private bucket holding meme images and NFT metadata JSON.
- CloudFront (Origin Access Control) is the public read path and is enabled in
  both Production and Preview, each backed by its own distribution per stack.
- A Next.js image proxy (`/api/image/[...key]`) is retained as a fallback for
  AWS accounts where CloudFront is not yet released by AWS support. It is
  selected only when `CLOUDFRONT_DOMAIN` is unset, so it is inactive in all
  deployed environments today. It reads the private bucket server-side, which
  is why it is a documented exception to the CloudFront-only read path.
- Clients upload directly to S3 via presigned URLs, bypassing Vercel.

### Auth : Amazon Cognito (identity provider)
- Cognito is the only identity system. `userId` is the Cognito `sub`.
- Sign-up requires at least one of email OR wallet (either alone is valid);
  the other can be linked later.
- Email login is standard Cognito.
- Wallet login: the client signs a server-issued nonce; a Vercel API route
  (`/api/auth/wallet/verify`) verifies the Solana signature, then mints a
  Cognito session via admin-initiated auth (`ADMIN_USER_PASSWORD_AUTH`) using a
  server-derived password for the `wallet_<addr>` user. The signature check
  happens in the API route, not inside Cognito. Cognito is still the only
  identity provider and the only issuer of sessions.
- There is no separate or parallel wallet/JWT session system alongside
  Cognito.
- `EMAIL#` and `WALLET#` lookups are sparse GSI entries (see GSI1 / GSI2).

### On-chain : Solana
- Solana: NFT mints via Metaplex, Solana Pay tips.
- Bags.fm: MOCKED (simulated SDK). Mainnet, post-deadline only. The single
  simulated link in the diagram.

#### RPC access
All browser RPC traffic goes through `/api/rpc` (`app/api/rpc/route.ts`), never
straight to the provider. A paid provider endpoint carries its API key in the
URL, and anything handed to a client component ships in the page the browser
downloads — so `SOLANA_RPC_URL` is server-only and the client is given
`SOLANA_CLIENT_RPC_PATH` (`/api/rpc`) instead, resolved against
`window.location.origin` in `components/WalletProvider.tsx`.

The proxy forwards only an allowlist of JSON-RPC methods
(`lib/solana/rpc-allowlist.ts`); without that it would be a free
general-purpose RPC billed to us. Adding an on-chain feature that needs a new
method means adding it there.

Consequence: the proxy is HTTPS-only, so the WebSocket `signatureSubscribe`
that `Connection.confirmTransaction` normally waits on is unavailable. Both the
tip and mint paths confirm by polling `getSignatureStatuses` instead
(`lib/solana/confirm.ts`); `lib/nft.ts` overrides umi's `confirmTransaction`
for the same reason. Any new send-and-confirm path must do the same.

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
| Leaderboard | `LEADERBOARD#GLOBAL` | `USER#<creatorId>`    | `memeCount` per creator, incremented/decremented by Streams to Lambda |

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
- Media reads go through CloudFront. The `/api/image` proxy is a fallback for
  accounts without CloudFront and is off whenever `CLOUDFRONT_DOMAIN` is set.
  Do not remove the proxy route. Clients never read the S3 bucket directly.
- `userId` is the Cognito `sub`; do not generate user IDs elsewhere.
- Wallet login verifies the signature in the `/api/auth/wallet/verify` API
  route, then issues a Cognito session via admin-initiated auth; do not build a
  parallel session/JWT system alongside Cognito.
- Ownership and listing changes are owner-gated at the DB via
  `ConditionExpression`; never bypass that check in application code.
- User on-chain actions are signed client-side; platform on-chain actions
  are signed server-side in Lambda.
- Bags.fm is mocked. Do not wire real mainnet calls without explicit approval.
