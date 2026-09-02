export interface Creator {
  id: string;
  walletAddress: string;
  username: string;
  avatarUrl: string;
  bio: string;
  bagsProjectId: string;
  token: CreatorToken;
  memeCount: number;
  joinedAt: string;
  isDemo?: boolean;
}

export interface CreatorToken {
  symbol: string;
  name: string;
  price: number;        // in SOL
  priceChange24h: number; // percent
  holders: number;
  totalVolume: number;  // SOL
  marketCap: number;    // SOL
  spiking: boolean;     // true when buy volume spikes
}

export interface Meme {
  id: string;
  creatorId: string;
  imageUrl: string;
  title: string;
  description: string;
  tags: string[];
  votes: number;
  comments: Comment[];
  isNFT: boolean;
  nftPrice?: number;  // SOL
  mintAddress?: string;
  postedAt: string;
  isMemeOfDay: boolean;
}

export interface Comment {
  id: string;
  authorId: string;
  authorUsername: string;
  authorAvatar: string;
  body: string;
  postedAt: string;
  tokenRequired?: string; // creator token symbol
}

export type BagsEvent =
  | { type: "project_created"; projectId: string }
  | { type: "token_created"; symbol: string; projectId: string }
  | { type: "token_purchased"; symbol: string; tokenAmount: number; sol: number }
  | { type: "token_sold"; symbol: string; tokenAmount: number; sol: number };

export type Tab = "today" | "week" | "all";

// DynamoDB single-table item types (table: MemeDay)

export interface DbUser {
  userId: string;           // Cognito sub — primary identity
  email?: string;
  walletAddr?: string;      // Solana public key (linked after signup)
  displayName?: string;
  authMethods: string[];    // e.g. ["email"] | ["wallet"] | ["email","wallet"]
  bagsProjectId?: string;
  creatorTokenAddr?: string;
  creatorTokenSymbol?: string;
  credScore: number;
  createdAt: string;
}

export interface DbMeme {
  id: string;
  creatorId: string;        // Cognito sub of creator (fixed)
  ownerId: string;          // Cognito sub of current owner (changes on sale)
  creatorWalletAddr?: string; // denormalized for Solana Pay tips
  s3Key: string;            // S3 object key
  imageUrl: string;         // CloudFront URL (derived from s3Key at read time)
  caption: string;
  nftMint?: string;         // Solana mint address
  status: "active" | "listed" | "sold" | "pending_review" | "removed"; // pending_review = flagged by content moderation (KAN-44); removed = admin takedown (KAN-43) — both never feed/profile/direct-URL visible
  likeCount: number;
  commentCount: number;
  score: number;
  listingPrice?: number;    // SOL, present when status = "listed"
  createdAt: string;
}

export interface DbPendingUpload {
  id: string;               // also the future memeId once finalized
  creatorId: string;        // Cognito sub
  s3Key: string;
  caption: string;
  status: "pending_upload" | "active" | "rejected";
  reason?: string;          // set when status = "rejected"
  createdAt: string;
}

export interface DbComment {
  id: string;
  memeId: string;
  userId: string;           // Cognito sub
  walletAddr?: string;      // for display (if user has a linked wallet)
  body: string;
  createdAt: string;
}

// Creator's Bags launch, once claimed and server-verified (KAN-29). Stored at
// PK = USER#<creatorId>, SK = TOKEN#<tokenMint> — same item collection as the
// User row, so a profile page read can pull both in one Query.
export interface DbBagsToken {
  creatorId: string;
  tokenMint: string;
  symbol: string;             // as supplied by the creator at claim time, not independently verified against Bags
  name: string;                // same caveat as symbol
  partnerAttributed: boolean; // verified server-side via GET /token-launch accountKeys
  verifiedAt: string;
}

export interface OpenReport {
  memeId: string;
  s3Key: string;
  imageUrl: string;
  reason: string;           // reason from the earliest report
  reporterCount: number;    // distinct reporters, not total reports
  firstReportedAt: string;
  lastReportedAt: string;
}
