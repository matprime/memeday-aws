"use client";

import { useAppStore, decodeJwtSub } from "@/lib/store";
import { BagsLaunchClaim } from "@/components/BagsLaunchClaim";

interface Props {
  memeId: string;
  imageUrl: string;
  caption: string;
  creatorId: string;
}

// The meme's own Bags launch. A token is bound to one meme and only its
// uploader may bind it (KAN-11), so this is the meme's page rather than the
// creator's — and it is the recovery path when bags.fm interrupts a launch
// started from the post-meme success screen, which the profile-level claim
// panel used to be (KAN-79): the claim box here is open from the start.
//
// The owner check is client-side against the existing Cognito access token —
// no new session mechanism, and POST /api/bags/verify re-checks it server-side
// against the meme row regardless.
export function MemeBagsLaunch({ memeId, imageUrl, caption, creatorId }: Props) {
  const { cognitoToken } = useAppStore();
  const viewerId = cognitoToken ? decodeJwtSub(cognitoToken) : null;

  if (viewerId !== creatorId) return null;

  return (
    <BagsLaunchClaim
      memeId={memeId}
      imageUrl={imageUrl}
      defaultName={caption}
      alwaysShowClaim
    />
  );
}
