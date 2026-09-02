// Single source of truth for every rate limit in the app (KAN-19). Nothing
// else should hardcode a max/window — add or tune a limit here only.
// These are starting values, not measured thresholds — expect to tune them
// once we see real traffic.

export interface RateLimitDef {
  // Also the DynamoDB SK prefix (see lib/rate-limit.ts), so it must stay
  // unique across this whole map.
  key: string;
  max: number;
  windowSeconds: number;
}

const DAY = 24 * 60 * 60;
const MINUTE = 60;
const HOUR = 60 * 60;

export const RATE_LIMITS = {
  // ── Per-user limits ───────────────────────────────────────────────────
  uploadPerUser: { key: "uploadPerUser", max: 10, windowSeconds: DAY },
  votePerUser: { key: "votePerUser", max: 200, windowSeconds: DAY },
  commentPerUser: { key: "commentPerUser", max: 50, windowSeconds: DAY },

  // ── Per-IP Sybil ceilings (uploads and comments only) ───────────────────
  // Not a per-person limit — a Sybil ceiling. It exists only to catch one
  // attacker running many accounts from one IP. An IP is shared by carrier
  // NAT, offices, and VPN exit nodes, so keep this loose: tightening it is
  // how you turn shared-IP users into false positives.
  uploadPerIp: { key: "uploadPerIp", max: 60, windowSeconds: DAY },
  commentPerIp: { key: "commentPerIp", max: 300, windowSeconds: DAY },

  // ── Per-IP limits (unauthenticated routes) ──────────────────────────────
  rpcPerIp: { key: "rpcPerIp", max: 60, windowSeconds: MINUTE },
  loginPerIp: { key: "loginPerIp", max: 10, windowSeconds: 15 * MINUTE },
  signupPerIp: { key: "signupPerIp", max: 5, windowSeconds: HOUR },
  forgotPasswordPerIp: { key: "forgotPasswordPerIp", max: 3, windowSeconds: HOUR },
  resetPasswordPerIp: { key: "resetPasswordPerIp", max: 10, windowSeconds: HOUR },
  confirmPerIp: { key: "confirmPerIp", max: 10, windowSeconds: HOUR },
  walletNoncePerIp: { key: "walletNoncePerIp", max: 20, windowSeconds: 15 * MINUTE },
  walletVerifyPerIp: { key: "walletVerifyPerIp", max: 20, windowSeconds: 15 * MINUTE },
  // Hit once per tab on load and roughly hourly per active session, so this
  // sits well above loginPerIp — it is an abuse ceiling, not a login throttle.
  refreshPerIp: { key: "refreshPerIp", max: 60, windowSeconds: 15 * MINUTE },

  // ── Content report (KAN-43) ─────────────────────────────────────────────
  // Unauthenticated route, so the per-IP ceiling is the only layer that
  // applies to anonymous reporters. Per-user applies in addition when the
  // caller is authenticated.
  reportPerUser: { key: "reportPerUser", max: 10, windowSeconds: DAY },
  reportPerIp: { key: "reportPerIp", max: 20, windowSeconds: DAY },

  // ── Bags launch verification (KAN-29) ───────────────────────────────────
  // Read-only against Bags and writes one DynamoDB item, so this guards
  // against someone hammering the Bags API through us, not a spend budget.
  bagsVerifyPerUser: { key: "bagsVerifyPerUser", max: 10, windowSeconds: DAY },
  bagsVerifyPerIp: { key: "bagsVerifyPerIp", max: 20, windowSeconds: DAY },
} as const satisfies Record<string, RateLimitDef>;

export type RateLimitName = keyof typeof RATE_LIMITS;
