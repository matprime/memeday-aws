"use client";

import { useAppStore, decodeJwtSub } from "@/lib/store";
import { BagsLaunchClaim } from "@/components/BagsLaunchClaim";

interface Props {
  profileUserId: string;
}

// Renders nothing unless the signed-in viewer is the profile owner (KAN-79).
// The owner check is client-side against the existing Cognito access token —
// no new session mechanism, no server-side auth check added to the profile
// page itself.
export function BagsProfileClaim({ profileUserId }: Props) {
  const { cognitoToken } = useAppStore();
  const viewerId = cognitoToken ? decodeJwtSub(cognitoToken) : null;

  if (viewerId !== profileUserId) return null;

  // Same truncated-id fallback the profile page itself uses when there's no
  // display name (see app/creator/[id]/page.tsx) — just a prefill, the
  // creator can edit it before verifying.
  const defaultName = `${profileUserId.slice(0, 4)}...${profileUserId.slice(-4)}`;

  return <BagsLaunchClaim defaultName={defaultName} />;
}
