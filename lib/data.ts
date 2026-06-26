import { Creator, DbUser, Meme } from "./types";

export const MOCK_CREATORS: Creator[] = [
  {
    id: "creator-1",
    walletAddress: "7xKs...Bg3P",
    username: "MemeLord9000",
    avatarUrl: "https://api.dicebear.com/8.x/bottts/png?seed=meme1",
    bio: "Professional meme archaeologist. Trading volatility for vibes.",
    bagsProjectId: "bags-proj-001",
    token: {
      symbol: "MLRD",
      name: "MemeLord Token",
      price: 0.042,
      priceChange24h: 18.4,
      holders: 312,
      totalVolume: 89.3,
      marketCap: 420.69,
      spiking: true,
    },
    memeCount: 47,
    joinedAt: "2024-01-15T00:00:00Z",
    isDemo: true,
  },
  {
    id: "creator-2",
    walletAddress: "3mNq...Xx7R",
    username: "CryptoJester",
    avatarUrl: "https://api.dicebear.com/8.x/bottts/png?seed=meme2",
    bio: "If it's not on-chain, did it even happen?",
    bagsProjectId: "bags-proj-002",
    token: {
      symbol: "JEST",
      name: "Jester Token",
      price: 0.018,
      priceChange24h: 7.2,
      holders: 198,
      totalVolume: 44.1,
      marketCap: 180.0,
      spiking: false,
    },
    memeCount: 29,
    joinedAt: "2024-02-20T00:00:00Z",
    isDemo: true,
  },
  {
    id: "creator-3",
    walletAddress: "9pQw...Lk2V",
    username: "PepeMaximalist",
    avatarUrl: "https://api.dicebear.com/8.x/bottts/png?seed=meme3",
    bio: "Every market cycle needs its prophet. I am the frog.",
    bagsProjectId: "bags-proj-003",
    token: {
      symbol: "PEPE",
      name: "Pepe Creator Token",
      price: 0.071,
      priceChange24h: 34.9,
      holders: 567,
      totalVolume: 210.5,
      marketCap: 710.0,
      spiking: true,
    },
    memeCount: 83,
    joinedAt: "2023-11-05T00:00:00Z",
    isDemo: true,
  },
  {
    id: "creator-4",
    walletAddress: "2aYt...Wc9F",
    username: "SolanaShaman",
    avatarUrl: "https://api.dicebear.com/8.x/bottts/png?seed=meme4",
    bio: "400ms TPS goes brrr. Memes are my consensus mechanism.",
    bagsProjectId: "bags-proj-004",
    token: {
      symbol: "SHAM",
      name: "Shaman Token",
      price: 0.033,
      priceChange24h: -2.1,
      holders: 145,
      totalVolume: 28.7,
      marketCap: 330.0,
      spiking: false,
    },
    memeCount: 21,
    joinedAt: "2024-03-10T00:00:00Z",
    isDemo: true,
  },
  {
    id: "creator-5",
    walletAddress: "5bZr...Mn4H",
    username: "DegenQueen",
    avatarUrl: "https://api.dicebear.com/8.x/bottts/png?seed=meme5",
    bio: "Exit liquidity is a mindset, not a strategy.",
    bagsProjectId: "bags-proj-005",
    token: {
      symbol: "DQEN",
      name: "DegenQueen Token",
      price: 0.055,
      priceChange24h: 11.3,
      holders: 423,
      totalVolume: 132.8,
      marketCap: 550.0,
      spiking: true,
    },
    memeCount: 61,
    joinedAt: "2024-01-28T00:00:00Z",
    isDemo: true,
  },
  {
    id: "creator-6",
    walletAddress: "8cWp...Rt5K",
    username: "WojakWhisperer",
    avatarUrl: "https://api.dicebear.com/8.x/bottts/png?seed=meme6",
    bio: "Bottom signal confirmed. Buy when there's blood in the timeline.",
    bagsProjectId: "bags-proj-006",
    token: {
      symbol: "WOJK",
      name: "Wojak Token",
      price: 0.029,
      priceChange24h: 52.7,
      holders: 689,
      totalVolume: 198.4,
      marketCap: 290.0,
      spiking: true,
    },
    memeCount: 74,
    joinedAt: "2023-12-12T00:00:00Z",
    isDemo: true,
  },
  {
    id: "creator-7",
    walletAddress: "1dFx...Qz8M",
    username: "GigaChadTrader",
    avatarUrl: "https://api.dicebear.com/8.x/bottts/png?seed=meme7",
    bio: "I don't time the market, the market times me. Still up 400%.",
    bagsProjectId: "bags-proj-007",
    token: {
      symbol: "GIGA",
      name: "GigaChad Token",
      price: 0.094,
      priceChange24h: 41.2,
      holders: 812,
      totalVolume: 215.9,
      marketCap: 940.0,
      spiking: true,
    },
    memeCount: 102,
    joinedAt: "2023-10-30T00:00:00Z",
    isDemo: true,
  },
  {
    id: "creator-8",
    walletAddress: "6eGy...Vb1N",
    username: "RugProofRita",
    avatarUrl: "https://api.dicebear.com/8.x/bottts/png?seed=meme8",
    bio: "LP locked, mint revoked, vibes immaculate. Audited by memes.",
    bagsProjectId: "bags-proj-008",
    token: {
      symbol: "RITA",
      name: "RugProof Token",
      price: 0.061,
      priceChange24h: 27.5,
      holders: 504,
      totalVolume: 156.2,
      marketCap: 610.0,
      spiking: true,
    },
    memeCount: 53,
    joinedAt: "2024-02-08T00:00:00Z",
    isDemo: true,
  },
];

const NOW = new Date();
const daysAgo = (d: number) =>
  new Date(NOW.getTime() - d * 86400000).toISOString();

export const MOCK_MEMES: Meme[] = [
  {
    id: "meme-1",
    creatorId: "creator-3",
    imageUrl: "https://picsum.photos/seed/meme1/600/400",
    title: "When your Solana tx confirms in 400ms but the bridge takes 7 days",
    description: "The duality of crypto. Speed vs. patience.",
    tags: ["solana", "bridge", "wait"],
    votes: 2847,
    isNFT: true,
    nftPrice: 0.5,
    mintAddress: "mint1...abc",
    postedAt: daysAgo(0),
    isMemeOfDay: true,
    comments: [
      {
        id: "c1",
        authorId: "creator-2",
        authorUsername: "CryptoJester",
        authorAvatar: "https://api.dicebear.com/8.x/bottts/png?seed=meme2",
        body: "This hits different at 3am while watching confirmations",
        postedAt: daysAgo(0),
      },
      {
        id: "c2",
        authorId: "creator-1",
        authorUsername: "MemeLord9000",
        authorAvatar: "https://api.dicebear.com/8.x/bottts/png?seed=meme1",
        body: "PEPE token to the moon though 🚀",
        postedAt: daysAgo(0),
      },
    ],
  },
  {
    id: "meme-2",
    creatorId: "creator-1",
    imageUrl: "https://picsum.photos/seed/meme2/600/400",
    title: "Me checking my portfolio every 5 minutes vs. my therapist's advice",
    description: "Chart watching is a sport.",
    tags: ["portfolio", "degen", "charts"],
    votes: 1923,
    isNFT: false,
    postedAt: daysAgo(0),
    isMemeOfDay: false,
    comments: [
      {
        id: "c3",
        authorId: "creator-5",
        authorUsername: "DegenQueen",
        authorAvatar: "https://api.dicebear.com/8.x/bottts/png?seed=meme5",
        body: "My therapist actually bought $MLRD so she's part of the problem now",
        postedAt: daysAgo(0),
      },
    ],
  },
  {
    id: "meme-3",
    creatorId: "creator-5",
    imageUrl: "https://picsum.photos/seed/meme3/600/400",
    title: "POV: You're the exit liquidity and you just realized it",
    description: "A moment of clarity nobody asked for.",
    tags: ["defi", "liquidty", "exit"],
    votes: 3102,
    isNFT: true,
    nftPrice: 1.2,
    mintAddress: "mint3...def",
    postedAt: daysAgo(1),
    isMemeOfDay: false,
    comments: [],
  },
  {
    id: "meme-4",
    creatorId: "creator-2",
    imageUrl: "https://picsum.photos/seed/meme4/600/400",
    title: "Gas fees on ETH vs. Solana. Choose your character.",
    description: "One chain costs your soul, the other costs 0.00005 SOL.",
    tags: ["ethereum", "solana", "gas"],
    votes: 4521,
    isNFT: true,
    nftPrice: 0.3,
    mintAddress: "mint4...ghi",
    postedAt: daysAgo(2),
    isMemeOfDay: false,
    comments: [
      {
        id: "c4",
        authorId: "creator-4",
        authorUsername: "SolanaShaman",
        authorAvatar: "https://api.dicebear.com/8.x/bottts/png?seed=meme4",
        body: "Blessed be the 400ms block time",
        postedAt: daysAgo(2),
      },
    ],
  },
  {
    id: "meme-5",
    creatorId: "creator-4",
    imageUrl: "https://picsum.photos/seed/meme5/600/400",
    title: "Every new crypto investor after their first green day",
    description: "We've all been here. Some of us never left.",
    tags: ["newbie", "green", "hopium"],
    votes: 876,
    isNFT: false,
    postedAt: daysAgo(3),
    isMemeOfDay: false,
    comments: [],
  },
  {
    id: "meme-6",
    creatorId: "creator-3",
    imageUrl: "https://picsum.photos/seed/meme6/600/400",
    title: "When the Bags creator token pumps 100x overnight",
    description: "Your creator economy era has arrived.",
    tags: ["bags", "pump", "creator"],
    votes: 5903,
    isNFT: true,
    nftPrice: 2.0,
    mintAddress: "mint6...jkl",
    postedAt: daysAgo(4),
    isMemeOfDay: false,
    comments: [],
  },
  {
    id: "meme-7",
    creatorId: "creator-1",
    imageUrl: "https://picsum.photos/seed/meme7/600/400",
    title: "Me explaining NFTs to my parents at Thanksgiving",
    description: "It's like a JPEG but on the blockchain, grandma.",
    tags: ["nft", "family", "explaining"],
    votes: 2341,
    isNFT: false,
    postedAt: daysAgo(5),
    isMemeOfDay: false,
    comments: [],
  },
  {
    id: "meme-8",
    creatorId: "creator-2",
    imageUrl: "https://picsum.photos/seed/meme8/600/400",
    title: "Staking rewards hit different when you're in a bear market",
    description: "0.004 SOL/day. We eat good.",
    tags: ["staking", "bear", "cope"],
    votes: 1654,
    isNFT: false,
    postedAt: daysAgo(6),
    isMemeOfDay: false,
    comments: [],
  },
];

export const getCreatorById = (id: string) =>
  MOCK_CREATORS.find((c) => c.id === id);

export const getMemeById = (id: string) =>
  MOCK_MEMES.find((m) => m.id === id);

export const getMemeOfDay = () => MOCK_MEMES.find((m) => m.isMemeOfDay)!;

export const getMemesThisWeek = () =>
  MOCK_MEMES.filter((m) => {
    const posted = new Date(m.postedAt);
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    return posted >= weekAgo;
  });

export const getTopCreators = () =>
  [...MOCK_CREATORS].sort(
    (a, b) => b.token.totalVolume - a.token.totalVolume
  );

export const getTopCreatorsByMemeCount = () =>
  [...MOCK_CREATORS].sort((a, b) => b.memeCount - a.memeCount);

export const getMemesByCreator = (creatorId: string) =>
  MOCK_MEMES.filter((m) => m.creatorId === creatorId);

export const getTrendingTokens = () =>
  [...MOCK_CREATORS].sort(
    (a, b) => b.token.priceChange24h - a.token.priceChange24h
  );

export const getSpikingTokens = () =>
  MOCK_CREATORS.filter((c) => c.token.spiking);

function walletHash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) & 0xffff;
  }
  return h;
}

export function creatorFromDbUser(
  user: DbUser & { memeCount: number; joinedAt: string }
): Creator {
  const { userId, walletAddr, bagsProjectId, creatorTokenSymbol, memeCount, joinedAt } = user;
  const seed = walletAddr ?? userId;
  const h = walletHash(seed);

  const token = creatorTokenSymbol
    ? {
        symbol: creatorTokenSymbol,
        name: `${creatorTokenSymbol} Token`,
        price: 0.001,
        priceChange24h: 0,
        holders: 0,
        totalVolume: 0,
        marketCap: 0,
        spiking: false,
      }
    : {
        symbol: seed.slice(0, 4).toUpperCase(),
        name: `${seed.slice(0, 4).toUpperCase()} Token`,
        price: parseFloat(((h % 80 + 5) / 1000).toFixed(4)),
        priceChange24h: parseFloat(((h % 50) - 10).toFixed(1)),
        holders: (h % 180) + memeCount * 5 + 5,
        totalVolume: parseFloat((memeCount * ((h % 8) + 1)).toFixed(1)),
        marketCap: parseFloat((((h % 80 + 5) / 1000) * ((h % 180) + memeCount * 5 + 5) * 0.1).toFixed(2)),
        spiking: h % 4 === 0,
      };

  return {
    id: userId,
    walletAddress: walletAddr ?? "",
    username: walletAddr
      ? `${walletAddr.slice(0, 4)}...${walletAddr.slice(-4)}`
      : `${userId.slice(0, 8)}...`,
    avatarUrl: `https://api.dicebear.com/8.x/identicon/png?seed=${seed}`,
    bio: "Meme creator on Solana",
    bagsProjectId: bagsProjectId ?? `mock-${userId.slice(0, 8)}`,
    token,
    memeCount,
    joinedAt,
  };
}
