# MemeDay Architecture

**Version 2. Last audited 2026-08-25 against `develop` @ `c921000`.**

Version 1 described a good deal of intended design as though it were built.
This revision separates what the code actually does from what is still a
plan. Anything marked PLANNED has no implementation in the repo today.
Anything marked UNVERIFIED could not be confirmed from source in this repo.

DynamoDB single-table primary store (single-region today; Global Tables
planned), Vercel + Lambda hybrid compute, S3 media behind CloudFront,
Streams-driven materialized views, Cognito identity provider (email +
server-verified wallet sign-in), Bags.fm mocked.

## Layers

### Frontend : Vercel / v0.app
Next.js, React, Tailwind, shadcn/ui. Wallet connect via the Solana wallet
adapter (`components/WalletProvider.tsx`).

### Compute : hybrid

Vercel serverless (Next.js API routes) handle all synchronous work:

| Route | Purpose |
|-------|---------|
| `/api/auth/email/{signup,confirm,login,forgot-password,reset-password}` | Cognito email auth |
| `/api/auth/wallet/{nonce,verify}` | Wallet challenge + signature verification |
| `/api/users` | User profile upsert |
| `/api/memes` | Finalize a validated pending upload into a feed-visible meme |
| `/api/memes/[id]/vote` | Voting |
| `/api/comments` | Comments |
| `/api/upload-url` | Issue an S3 presigned PUT URL |
| `/api/upload-status/[id]` | Poll a pending upload's validation status |
| `/api/nft-metadata`, `/api/nft-metadata/[id]` | Register and serve NFT metadata JSON |
| `/api/rpc` | Allowlisted Solana JSON-RPC proxy |
| `/api/image/[...key]` | S3 image proxy (see the caveat under Media) |

AWS Lambda handles event-driven and privileged work. Exactly three functions
exist, all defined in `infra/lib/memeday-stack.ts`:

| Lambda | Trigger | Does |
|--------|---------|------|
| `StreamHandler` | DynamoDB Streams (NEW_AND_OLD_IMAGES, batch 100, bisect on error, 3 retries) | Maintains the `FEED#GLOBAL` and `LEADERBOARD#GLOBAL` materialized views |
| `S3Handler` | S3 `OBJECT_CREATED`, prefix `uploads/` | Validates, sanitizes and re-encodes uploads; then invokes ModerationHandler |
| `ModerationHandler` | Direct async invoke from `S3Handler` (`InvocationType: "Event"`) | Rekognition content moderation |

There is NO EventBridge / cron-triggered Lambda in the stack today. PLANNED.

No Lambda performs on-chain signing today. There is no server-side signer in
the repo; every Solana transaction is signed client-side by the user's wallet.
Server-side signing for platform actions is PLANNED.

ModerationHandler has no S3 subscription of its own: S3 rejects two
overlapping `OBJECT_CREATED` + prefix subscriptions as ambiguous. S3Handler
invoking it directly also guarantees moderation runs on the final,
re-encoded asset rather than the raw upload.

### Data : Amazon DynamoDB (single-table primary store)
One table per stage, `MemeDayProd` and `MemeDayDev` (NOT `MemeDay`; the prod
table was renamed to create all three GSIs in one deploy, and the original
`MemeDay` table is retained as the rollback artifact). Single-region.
Global Tables are PLANNED but not deployed; the single-table design is built
to drop into them without remodeling. Streams enabled. PAY_PER_REQUEST.

TTL is enabled on the attribute `expiresAt`. Only `PENDING#` and `RATE#`
items are ever written with it, so memes, users and comments are never
touched by TTL.

### Media : Amazon S3 + CloudFront
- S3 is a private bucket (`BLOCK_ALL` public access) holding meme images.
  NFT metadata JSON is served from DynamoDB via `/api/nft-metadata/[id]`,
  not from S3.
- CloudFront (Origin Access Control) is the public read path, one
  distribution per stack.
- Clients upload directly to S3 via presigned PUT URLs, bypassing Vercel.
  Bucket CORS allows `PUT` from any origin.
- A Next.js image proxy (`/api/image/[...key]`) exists and is selected by
  `cfUrl()` in `lib/db.ts` whenever `CLOUDFRONT_DOMAIN` is unset. **It cannot
  work in a deployed environment**: the Vercel runtime IAM user deliberately
  does not have `s3:GetObject` (KAN-38 decided to accept a 500 on that path
  rather than keep the grant). Treat it as a local-development affordance,
  not a production fallback. Do not remove the route without also changing
  `cfUrl()`.

### Auth : Amazon Cognito (identity provider)
- Cognito is the only identity system. `userId` is the Cognito `sub`.
- Sign-up requires at least one of email OR wallet (either alone is valid);
  the other can be linked later. The pool enforces this: `email` is
  `required: false`, sign-in aliases are username + email, and wallet users
  get the opaque username `wallet_<walletAddress>`.
- Enabled auth flows are `adminUserPassword` (wallet login), `userSrp`
  (email/password), and `refreshTokenAuth` (session renewal — CDK adds
  `ALLOW_REFRESH_TOKEN_AUTH` to every client by default).
- Email login is standard Cognito. The route resolves an email to a username
  with `ListUsers`, not via a DynamoDB index.
- Wallet login (`app/api/auth/wallet/`):
  1. `/nonce` issues a challenge `<timestampMs>:<walletAddress>:<random>.<hmac>`,
     HMAC-SHA256 over the nonce with `WALLET_AUTH_SECRET`.
  2. The client signs the challenge string with the wallet.
  3. `/verify` re-derives the HMAC, enforces a 5-minute TTL, checks the
     embedded wallet address, then verifies the ed25519 signature. It accepts
     the raw message plus four Solana off-chain message envelope variants,
     because Ledger devices refuse to sign raw bytes.
  4. On first sight of a wallet it creates the Cognito user with a
     deterministic server-derived password
     (`HMAC(WALLET_AUTH_SECRET, "pwd:" + address)` base64url, plus an `Aa1!`
     suffix to satisfy the pool password policy) and suppresses the welcome
     email.
  5. It then issues the session with `AdminInitiateAuth` /
     `ADMIN_USER_PASSWORD_AUTH` and returns the access token, plus an
     `isNewUser` flag so the client can distinguish a first sign-up from a
     return login.
- This is NOT a Cognito custom-auth (`CUSTOM_AUTH`) challenge flow. There are
  no Define/Create/VerifyAuthChallenge Lambda triggers. The signature check
  happens in the API route. Cognito is still the only identity provider and
  the only issuer of sessions.
- API routes authenticate the caller by verifying the Cognito **access**
  token with `aws-jwt-verify` (`lib/cognito.ts`) and taking `payload.sub`.
- Session lifetime uses Cognito's own two-token model. The access token is
  short-lived (pool default, 60 min) and lives in `localStorage`; the refresh
  token lives 30 days in an httpOnly `md_rt` cookie scoped to `/api/auth`, so
  page JS can never read it. `/api/auth/refresh` trades that cookie for a new
  access token via `AdminInitiateAuth` with `AuthFlow: REFRESH_TOKEN_AUTH`.
  `/api/auth/logout` clears the cookie.
- A stored access token is never trusted because it exists — only because its
  `exp` is still in the future. `lib/session.ts` `getAccessToken()` is the only
  supported way to obtain a token for an API call; it renews first if the
  stored one is stale. `components/SessionSync.tsx` runs the same check once
  per page load so the UI's signed-in state reflects a session that actually
  works. Checking a token's presence instead of its expiry is what let the app
  render as connected on top of a dead session.
- Consequence: a returning user is renewed silently. The wallet is not asked to
  re-sign the nonce on refresh or on a return visit within the refresh token's
  30 days; re-signing happens only when that token is gone or rejected.
- There is no separate or parallel wallet/JWT session system alongside
  Cognito. The refresh cookie is transport for a Cognito-issued token, not a
  second session mechanism.
- `upsertUser` writes sparse `EMAIL#` (GSI1) and `WALLET#` (GSI2) index keys.
  Only the `WALLET#` one is currently read by any query. See GSI notes below.

### On-chain : Solana

#### Network selection and kill switch
`lib/solana/network.ts` is the single choke point. Nothing else may read
`SOLANA_*` or hardcode a cluster.
- `SOLANA_NETWORK` must be exactly `devnet` or `mainnet`; anything else
  throws at import.
- `mainnet` additionally requires `VERCEL_ENV=production`. Preview, local and
  CI reject a mainnet request outright rather than downgrading it silently.
- A mismatch guard rejects `SOLANA_NETWORK=devnet` with a mainnet-looking
  `SOLANA_RPC_URL` and vice versa, matched on provider hostname conventions.
  A custom hostname naming neither cluster passes through unchecked.
- `SOLANA_ENABLED` (`"true"` / `"false"`) is an explicit kill switch that
  calling code short-circuits on, with `SOLANA_DISABLED_MESSAGE` for the UI.

#### What is live vs mocked
- NFT mints: LIVE, `lib/nft.ts`, Metaplex Token Metadata (classic
  NonFungible) via umi `createNft`. `sellerFeeBasisPoints` 2.5%,
  `isMutable: false`, symbol `MDAY`. Signed client-side by the user's wallet.
- Solana Pay tips: LIVE, `lib/solana/tip.ts`.
- Bags.fm: MOCKED (`lib/bags.ts`, simulated delays, no network calls).
  Mainnet, post-deadline only. The single simulated link in the diagram.

#### RPC access
All browser RPC traffic goes through `/api/rpc` (`app/api/rpc/route.ts`),
never straight to the provider. A paid provider endpoint carries its API key
in the URL, and anything handed to a client component ships in the page the
browser downloads, so `SOLANA_RPC_URL` is server-only and the client is given
`SOLANA_CLIENT_RPC_PATH` (`/api/rpc`) instead, resolved against
`window.location.origin` in `components/WalletProvider.tsx`.

The proxy forwards only an allowlist of JSON-RPC methods
(`lib/solana/rpc-allowlist.ts`); without that it would be a free
general-purpose RPC billed to us. A batch is rejected whole if any member is
off-allowlist. Adding an on-chain feature that needs a new method means
adding it there. Deliberately excluded: `getProgramAccounts`,
`getSignaturesForAddress`, `getBlock*`, `getTransaction`, and the DAS
endpoints.

Consequence: the proxy is HTTPS-only, so the WebSocket `signatureSubscribe`
that `Connection.confirmTransaction` normally waits on is unavailable. Both
the tip and mint paths confirm by polling `getSignatureStatuses` instead
(`lib/solana/confirm.ts`); `lib/nft.ts` overrides umi's `confirmTransaction`
for the same reason. Any new send-and-confirm path must do the same.

## Single-table data model

Base table `MemeDayProd` / `MemeDayDev`. `PK` = partition key, `SK` = sort
key. All entities are modeled as item types on one table. Rows sharing
`PK = MEME#<memeId>` form one item collection (a meme's metadata, comments
and likes) retrievable in a single query.

### Implemented entities

| Entity | PK | SK | Key attributes |
|--------|----|----|----------------|
| User | `USER#<userId>` | `USER#<userId>` | `userId`, `email?`, `walletAddr?`, `displayName?`, `authMethods`, `bagsProjectId?`, `creatorTokenAddr?`, `creatorTokenSymbol?`, `credScore`, `createdAt` (userId = Cognito sub; need >=1 of email/wallet) |
| Meme | `MEME#<memeId>` | `MEME#<memeId>` | `memeId`, `creatorId`*, `ownerId`+, `creatorWalletAddr?`, `s3Key`, `caption`, `nftMint?`, `status`, `likeCount`, `commentCount`, `score`, `listingPrice?`, `createdAt` |
| Comment | `MEME#<memeId>` | `COMMENT#<createdAt>#<commentId>` | `commentId`, `memeId`, `userId`, `walletAddr?`, `body`, `createdAt` |
| Like | `MEME#<memeId>` | `LIKE#<userId>` | `createdAt` (one item per user = dedupe) |
| PendingUpload | `PENDING#<pendingId>` | `PENDING#<pendingId>` | `pendingId`, `creatorId`, `s3Key`, `caption`, `status`, `reason?`, `createdAt`, `expiresAt` (TTL, 24h) |
| NftMetadata | `NFTMETA#<id>` | `NFTMETA#<id>` | `nftMetaId`, `name`, `image_url`, `description`, `createdAt` |
| RateLimit counter | `RATE#<identity>` | `<limitKey>#<windowStart>` | `requestCount`, `expiresAt` (TTL, window + 60s) |
| Feed item | `FEED#GLOBAL` | `<score padded to 15 digits>#<memeId>` | snapshot: `memeId`, `creatorId`, `s3Key`, `caption`, `score`, plus `GSI3PK`/`GSI3SK`. Written only by StreamHandler |
| Leaderboard | `LEADERBOARD#GLOBAL` | `USER#<creatorId>` | `creatorId`, `memeCount`, incremented/decremented by StreamHandler |

\* `creatorId` is fixed.  + `ownerId` is currently always equal to
`creatorId`; nothing changes it yet (see NFT resale below).

Meme `status` values in code: `active`, `listed` (set when `listingPrice` is
present at finalize), `pending_review` (set by ModerationHandler). Items
predating KAN-44 may have no `status` at all, which is treated as
feed-eligible.

`score` is currently only ever incremented in lockstep with `likeCount` by
`voteMeme`, so today `score == likeCount`. It is a separate attribute so a
richer ranking can be introduced without a migration.

### PLANNED entities (described in v1, no implementation exists)

| Entity | PK | SK | Status |
|--------|----|----|--------|
| Ownership | `MEME#<memeId>` | `OWNERSHIP#<ts>#<txSig>` | PLANNED. Zero occurrences in the codebase |
| Listing | `MEME#<memeId>` | `LISTING#ACTIVE` | PLANNED. Zero occurrences. The current placeholder is a `listingPrice` attribute on the `MEME#` item itself |

### Global secondary indexes (overloaded)

All three are declared identically in CDK: generic `GSI<n>PK` / `GSI<n>SK`
string key pairs with the default (ALL) projection. What they mean is a
convention held in application code, not in the table definition.

| Index | GSI PK | GSI SK | Written by | Read by |
|-------|--------|--------|-----------|---------|
| GSI1 | `USER#<creatorId>` | `MEME#<createdAt>` | `createMeme` | `getMemesByCreator` (creator profile) |
| GSI1 (sparse) | `EMAIL#<email>` | `USER#<userId>` | `upsertUser` | Nothing today. Email login resolves through Cognito `ListUsers` instead. Kept because it is the cheap path if that changes |
| GSI2 | `OWNER#<ownerId>` | `MEME#<createdAt>` | `createMeme` | Nothing today. Intended for "memes a user owns" once resale exists |
| GSI2 (sparse) | `WALLET#<addr>` | `USER#<userId>` | `upsertUser` | `getUserByWallet` |
| GSI3 | `FEED#GLOBAL` | `<createdAt>` | StreamHandler, on feed items | `getMemes` (newest-first global feed) |

GSI3 `MARKET#LISTED` sorted by zero-padded `priceSol`, described in v1, is
PLANNED. Nothing writes or reads it.

There is no index on `LIKE#` items. The v1 claim that GSI1 maps `USER#` to a
user's likes is not implemented.

### Served on the base table (no GSI)
- Comments: `PK = MEME#<id>`, `SK begins_with COMMENT#`
- "Did user like?": `GetItem` on `LIKE#<userId>`
- Meme of the day: `Query PK = FEED#GLOBAL`, `ScanIndexForward: false`,
  `Limit: 1`. This is why the feed item SK zero-pads the score to 15 digits:
  it makes DynamoDB's lexicographic sort equal a numeric sort.
- Leaderboard: `Query PK = LEADERBOARD#GLOBAL`
- Sale history (`SK begins_with OWNERSHIP#`): PLANNED, see above.

`getAllUsers` in `lib/db.ts` uses a `Scan`. It has zero callers, and the
runtime IAM user is deliberately not granted `dynamodb:Scan`, so calling it
in a deployed environment would fail with AccessDenied.

### NFT resale : ownership transfer and pricing (PLANNED)
None of this is implemented. It is recorded here as the intended design, not
as a description of current behavior.
- `ownerId` should be mutable and changed only by the current owner, via
  `UpdateItem` with `ConditionExpression ownerId = :caller`, so non-owners
  (including the original creator) fail at the DB.
- For-sale browsing should use GSI3 `MARKET#LISTED` sorted by price, with
  `priceSol` zero-padded in the SK so ordering is correct.
- A sale should be a single `TransactWriteItems`: write the
  `OWNERSHIP#<ts>` record, re-point the meme's `ownerId` and GSI2 PK to
  `OWNER#<buyer>`, and clear the active listing, so a price change cannot be
  raced. The on-chain Metaplex transfer is reconciled after confirmation.

## Upload, validation and moderation pipeline

1. `GET /api/upload-url` authenticates the caller, applies the
   `uploadPerUser` and `uploadPerIp` limits, writes a `PENDING#<id>` item
   with status `pending_upload`, and returns a 5-minute presigned PUT URL for
   `uploads/<userId>/<pendingId>.<ext>`.
2. The client PUTs the file straight to S3.
3. `S3Handler` fires on `OBJECT_CREATED` under `uploads/`. It:
   - rejects GIF and WEBP explicitly, because Rekognition's
     `DetectModerationLabels` only supports JPEG/PNG so they cannot be
     screened (temporary, KAN-48);
   - rejects any extension other than jpg/jpeg/png;
   - rejects files over 5 MB;
   - sniffs the real format with sharp and rejects a mismatch against the
     claimed extension (disguised file);
   - rejects images outside 600 to 4096 px on either axis;
   - strips EXIF by re-encoding with sharp and writes the cleaned file back
     to the same key with object metadata `validated=true`, which is also the
     guard against the resulting `OBJECT_CREATED` re-triggering this Lambda;
   - marks the pending record `active`, or `rejected` with a reason and
     deletes the object.
   An upload whose `PENDING#` record is missing is treated as an orphan and
   the object is deleted.
4. `S3Handler` then invokes `ModerationHandler` asynchronously. This invoke is
   fire-and-forget: a failure must not roll back validation that already
   succeeded. `ModerationHandlerErrorsAlarm` is the backstop.
5. `ModerationHandler` calls Rekognition `DetectModerationLabels` with
   `MinConfidence: 50`, then blocks if any returned label is in its explicit
   block list (explicit nudity, graphic violence, weapons, hate symbols) at
   confidence >= 80. The API-level minimum and the block threshold are
   deliberately different numbers. It is FAIL-OPEN: a Rekognition error logs
   and leaves state as-is.
6. A block applies to whichever record still represents the upload:
   - `PENDING#` still exists (the common case): status `rejected` with a
     generic reason.
   - the client already finalized: the `MEME#` item gets status
     `pending_review`.
   - neither: logged as `blocked_orphan`.
7. `POST /api/memes` refuses to finalize unless the pending record is
   `status: "active"` and owned by the caller (`425` if still validating,
   `422` if rejected). It reads the creator's wallet address at finalize
   time, not at presign time, because the client upserts its profile in
   between.

`pending_review` memes are excluded everywhere: `getMemeById` returns null,
`getMemesByCreator` filters them, and StreamHandler both refuses to add them
to `FEED#GLOBAL` and pulls them back out (undoing the leaderboard increment)
if they are flagged after publishing.

Note a known inconsistency: `app/api/upload-url` still lists `gif` and `webp`
in its allowed extensions, so a presigned URL is issued for a file that
`S3Handler` will then reject and delete. The rejection is correct, but the
round trip is wasted and it consumes an upload rate-limit slot.

## Rate limiting (KAN-19)

`lib/rate-limit-config.ts` is the single source of truth for every limit.
Nothing else may hardcode a max or window. Current limits are starting
values, not measured thresholds.

- Per user, per day: 10 uploads, 200 votes, 50 comments.
- Per IP Sybil ceilings, per day: 60 uploads, 300 comments. These are not
  per-person limits. An IP is shared by carrier NAT, offices and VPN exits,
  so they are deliberately loose.
- Per IP on unauthenticated routes: 60 rpc/min, 10 logins/15min,
  5 signups/hour, 3 forgot-password/hour, 10 reset-password/hour,
  10 confirm/hour, 20 wallet-nonce/15min, 20 wallet-verify/15min.

Mechanics (`lib/rate-limit.ts`):
- FIXED WINDOW, not sliding or token bucket. A caller can burst up to ~2x at
  a window boundary. This guards a cost budget, not a billing meter, so that
  is a deliberate tradeoff against complexity.
- One atomic DynamoDB `ADD` per check, against `RATE#<identity>` /
  `<limitKey>#<windowStart>`, with TTL set to window end plus 60s.
- FAIL-OPEN. A failed counter write logs and lets the request through. A
  DynamoDB hiccup must never be the reason a real user gets a 429.
- Client IP comes from `x-forwarded-for`, which on Vercel is set by its own
  edge from the real TCP connection. The multi-entry warning in `getClientIp`
  is a canary for a CDN being placed in front of Vercel, which would make the
  first entry client-supplied and spoofable. Do not delete it as dead code.
- Identities are salted-hashed (with `WALLET_AUTH_SECRET`) before logging.
  Raw IPs and Cognito subs are personal data; the deployment runs from the EU.
- The 429 body is identical on every route, so it cannot be used as a tuning
  oracle or an account-existence oracle.

## Observability

- SNS topic `memeday-alerts` (prod) / `memeday-alerts-dev`, email
  subscriptions from stack props.
- CloudWatch alarms, all on a 5-minute window with `NOT_BREACHING` on missing
  data: Errors > 0 for each of StreamHandler, S3Handler and ModerationHandler;
  DynamoDB `ThrottledRequests` > 0 on the table and its GSIs (PAY_PER_REQUEST
  can still throttle); `MemeDay/RateLimitCounterFailure` > 20, dimensioned by
  `Stage`, which is the only signal that the fail-open rate limiter is
  silently letting everything through.
- `MemeDay` is the custom metric namespace. Keep any future metric under it.
- PostHog product analytics from the client (`lib/analytics.ts`). The event
  vocabulary is a closed list mirrored in `docs/ANALYTICS_EVENTS.md`, and
  `test/analytics-events.test.js` fails if the two drift.

## IAM (KAN-17)

The Vercel runtime uses a dedicated IAM user, `memeday-runtime-prod` /
`memeday-runtime-dev`, with a scoped inline policy. The action lists were
grepped from actual SDK calls in `app/` and `lib/`, not guessed:
- DynamoDB `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`,
  `BatchGetItem` on the table and its indexes. `Scan` excluded on purpose.
- The exact 10 Cognito actions used across `app/api/auth/**`.
- S3 `PutObject` on `uploads/*` only. `GetObject` excluded on purpose
  (KAN-38), which is what disables the `/api/image` proxy in deployment.
- CloudWatch `PutMetricData`, conditioned on namespace `MemeDay`.

These users predate the stack and each needs a one-time `cdk import` per
stack to be adopted into CloudFormation before `cdk deploy` will succeed.

Lambdas have their own execution roles. S3Handler and ModerationHandler get
S3 access scoped to `uploads/*`, and `lambda:InvokeFunction` on
ModerationHandler specifically, not `*`.

## Admin

There are no admin routes, admin roles, or moderation review UI in the
codebase today. `pending_review` is a terminal state with no path out of it.
An operator review path is PLANNED and unbuilt.

## Data flow rules (directives)
- Feed reads, voting, CRUD, and auth callbacks go through Vercel API routes.
- Stream and S3-triggered work goes through Lambda. Cron-triggered and
  server-side-signing Lambdas do not exist yet; adding either means adding
  the trigger and the role, not repurposing an existing function.
- Trending / Leaderboard / Daily featured are served from materialized
  views (Streams to Lambda), never computed live from base items.
- Media uploads go client to S3 (presigned), not client to Vercel to S3.
- Media reads go through CloudFront. Clients never read the S3 bucket
  directly. The `/api/image` proxy is not a working production fallback; see
  Media above.
- `userId` is the Cognito `sub`; do not generate user IDs elsewhere.
- Wallet login verifies the signature in the `/api/auth/wallet/verify` API
  route, then issues a Cognito session via admin-initiated auth; do not build
  a parallel session/JWT system alongside Cognito.
- Client code gets access tokens from `getAccessToken()` (`lib/session.ts`),
  never by reading `cognitoToken` out of the store. Reading the store directly
  sends whatever is in `localStorage`, expired or not.
- Never read `SOLANA_*` or hardcode a cluster outside `lib/solana/network.ts`.
- Never hardcode a rate limit outside `lib/rate-limit-config.ts`.
- Every new send-and-confirm path must poll `getSignatureStatuses`; the RPC
  proxy cannot hold a WebSocket open.
- Every new RPC method must be added to `lib/solana/rpc-allowlist.ts` or it
  will 403.
- Ownership and listing changes must be owner-gated at the DB via
  `ConditionExpression` when resale is built; never bypass that in
  application code.
- User on-chain actions are signed client-side. Platform on-chain actions are
  PLANNED to be signed server-side in Lambda; no such path exists yet.
- Bags.fm is mocked. Do not wire real mainnet calls without explicit approval.
