// What a finished post actually achieved, in one place because two surfaces
// have to agree on it: the toast fired when the meme saves, and the success
// screen the modal stays open on. A cancelled mint used to reach both as a
// plain "Meme posted!", which told the user their NFT existed when it did not.

export interface PostOutcome {
  tone: "success" | "warning";
  message: string;
}

export function postOutcome(params: {
  caption: string;
  isNFT: boolean;
  minted: boolean;
}): PostOutcome {
  const { caption, isNFT, minted } = params;
  // The ellipsis marks a caption that was actually cut, rather than following
  // every name regardless — "test…" read as though something was missing.
  const shown = caption.slice(0, 30);
  const quoted = `"${shown}${shown.length < caption.length ? "…" : ""}"`;
  if (isNFT && !minted) {
    return {
      tone: "warning",
      message: `Meme posted, but the NFT wasn't minted — ${quoted}`,
    };
  }
  return { tone: "success", message: `Meme posted! ${quoted}` };
}
