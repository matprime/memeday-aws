# MemeDay analytics events

Shared vocabulary for founders and Claude Code. **This file is the source of truth.**
The copy in the Drive folder (`Hackathon AWS: MemeDay`) is a point-in-time export —
after editing this file, re-export it to Drive so the two do not drift.

Event names live in code at `lib/analytics.ts` (`EVENTS`). `test/analytics-events.test.js`
fails if a name in that registry is missing from this doc.

## Tooling

| Layer | Tool | Notes |
|---|---|---|
| Product events + funnels | PostHog Cloud, free tier | 1M events/mo, 5K session replays, 1M flag requests, 1-year retention, no credit card ([pricing](https://posthog.com/pricing), verified Aug 2026) |
| Page views | Vercel Analytics | `<Analytics />` in `app/layout.tsx` |

PostHog is initialised in `lib/analytics.ts` with `persistence: "localStorage"` — **no
analytics cookies**. The footer carries a matching one-line notice. If
`NEXT_PUBLIC_POSTHOG_KEY` is unset (local dev, tests) `track()` is a no-op and nothing
is sent.

`$pageview` is captured automatically on App Router client navigations via PostHog's
`defaults: "2025-05-24"` (history-change capture). There is no custom pageview code.

Autocapture and web-vitals capture are **off** (`autocapture: false`,
`capture_performance: false`). PostHog otherwise logs every click, input and form
submit (`clicked button with text "2"`), which buries the deliberate events below and
answers no question we're asking. The only events sent are `$pageview`, `$pageleave`,
and the table below. Turn autocapture back on temporarily if you need to discover what
people click that isn't instrumented — then turn it off again.

## Global properties

Registered as super-properties on every event:

| Property | Value |
|---|---|
| `platform` | `"web"` |
| `network` | `NEXT_PUBLIC_SOLANA_NETWORK`, default `"devnet"` |
| `environment` | `NODE_ENV` — `"development"` locally, `"production"` on Vercel |

**Every saved insight must filter on `environment = "production"`.** The PostHog free
tier allows one project, so local dev and production share it; without that filter,
developer clicks land in the funnels you are trying to read.

## Events

| Event | Fires when | Properties | Emitted from |
|---|---|---|---|
| `signup_completed` | A **new** account becomes usable. Email: after the verification code is confirmed and the auto-login succeeds. Wallet: first-ever signature verification for that address (`isNewUser` from `/api/auth/wallet/verify`). Return logins do **not** fire it. | `method`: `"email" \| "wallet"` | `components/EmailAuthModal.tsx`, `components/WalletAuthSync.tsx` |
| `meme_uploaded` | `POST /api/memes` succeeded — image uploaded, Lambda validation passed, row written. | `memeId`, `isNFT`, `minted` | `components/PostMemeModal.tsx` |
| `vote_cast` | Vote accepted by the server. Not fired for duplicate votes or failures. | `memeId`, `surface`: `"feed" \| "detail"` | `components/MemeCard.tsx`, `components/MemeActionBar.tsx` |
| `comment_posted` | `POST /api/comments` succeeded. Not fired for empty bodies, logged-out attempts, or failures. | `memeId` | `components/CommentSection.tsx` |
| `tip_qr_shown` | Tip modal renders the Solana Pay QR with a valid amount. Once per modal open, not per amount edit. | `memeId` | `components/TipModal.tsx` |
| `tip_link_opened` | User taps Send Tip with **no** connected wallet, so the `solana:` deep link is opened instead. | `memeId`, `amountSol` | `components/TipModal.tsx` |
| `mint_started` | NFT mint begins (Phantom signature prompt about to appear). | — | `components/PostMemeModal.tsx` |
| `mint_confirmed` | `createNft(...).sendAndConfirm` returned at `confirmed` commitment. | `mintAddress` | `components/PostMemeModal.tsx` |
| `share_clicked` | **Reserved, not emitted yet.** User clicks share on a meme. | `memeId`, `channel` | share-tracking task |
| `visit_from_share` | **Reserved, not emitted yet.** Landing hit carrying a share referrer param. | `memeId`, `channel` | share-tracking task |

Mint events deliberately carry **no** `memeId`: the meme row is created after the mint
completes, so at mint time no id exists. Join them to the upload by person/session.

An on-chain tip that goes through a connected wallet is not tracked yet — only the QR
display and the deep-link fallback are. Add `tip_sent` when tips move past validation.

## Saved views to build in PostHog

Both are funnels, ordered, default 1-day conversion window.

**Activation funnel** — visit → signup → upload
1. `$pageview`
2. `signup_completed`
3. `meme_uploaded`

**Money funnel** — view meme → tip/mint intent → confirmed
1. `$pageview` where `$pathname` contains `/meme/`
2. Any of `tip_qr_shown`, `mint_started`
3. `mint_confirmed`

Breakdown suggestions: `signup_completed` by `method`; `vote_cast` by `surface`;
everything by `network` once prod runs mainnet.

## Environment variables

| Var | Where | Required |
|---|---|---|
| `NEXT_PUBLIC_POSTHOG_KEY` | Vercel project settings (prod), `.env.local` (dev) | Yes for events to send |
| `NEXT_PUBLIC_POSTHOG_HOST` | same | No — defaults to `https://eu.i.posthog.com` (this project is on PostHog EU) |
| `NEXT_PUBLIC_SOLANA_NETWORK` | same | No — defaults to `devnet` |
