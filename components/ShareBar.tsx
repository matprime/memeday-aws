"use client";

import { useEffect, useState } from "react";
import { X, Send, MessageSquare, Facebook, Link2, Share2 } from "lucide-react";
import { EVENTS, track } from "@/lib/analytics";
import { useAppStore } from "@/lib/store";

interface Props {
  memeId: string;
  caption: string;
  creatorHandle: string;
  surface: "feed" | "detail";
  triggerClassName: string;
}

type Channel = "x" | "telegram" | "whatsapp" | "reddit" | "facebook" | "copy" | "native";

function buildShareUrl(memeId: string, channel: Channel) {
  const origin = window.location.origin;
  return `${origin}/meme/${memeId}?ref=share&ch=${channel}&m=${memeId}`;
}

export function ShareBar({ memeId, caption, creatorHandle, surface, triggerClassName }: Props) {
  const { addToast } = useAppStore();
  const [open, setOpen] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Feature-detect + pointer check, not just navigator.share: some desktop
    // browsers (Safari macOS, some Edge) also expose navigator.share, and we
    // want those to get the per-platform overlay (and its per-channel
    // shareClicked tracking) instead of skipping straight to a native sheet.
    setCanNativeShare(
      typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches
    );
  }, []);

  const shareText = `${caption.length > 100 ? caption.slice(0, 100) + "…" : caption} by @${creatorHandle}`;

  const handleTriggerClick = async () => {
    if (canNativeShare) {
      const url = buildShareUrl(memeId, "native");
      try {
        await navigator.share({ title: caption, text: shareText, url });
        track(EVENTS.shareClicked, { memeId, channel: "native", surface });
      } catch {
        // User cancelled the native share sheet — not an error.
      }
      return;
    }
    setOpen(true);
  };

  const handlePlatformClick = (channel: Exclude<Channel, "copy" | "native">) => {
    const url = buildShareUrl(memeId, channel);
    const text = encodeURIComponent(shareText);
    const encodedUrl = encodeURIComponent(url);
    let shareLink: string;
    switch (channel) {
      case "x":
        shareLink = `https://x.com/intent/tweet?text=${text}&url=${encodedUrl}`;
        break;
      case "telegram":
        shareLink = `https://t.me/share/url?text=${text}&url=${encodedUrl}`;
        break;
      case "whatsapp":
        shareLink = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${url}`)}`;
        break;
      case "reddit":
        shareLink = `https://www.reddit.com/submit?url=${encodedUrl}&title=${text}`;
        break;
      case "facebook":
        shareLink = `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`;
        break;
    }
    window.open(shareLink, "_blank", "noopener,noreferrer");
    track(EVENTS.shareClicked, { memeId, channel, surface });
  };

  const handleCopy = async () => {
    const url = buildShareUrl(memeId, "copy");
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      track(EVENTS.shareClicked, { memeId, channel: "copy", surface });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      addToast("Copy failed", "error");
    }
  };

  return (
    <>
      <button onClick={handleTriggerClick} className={triggerClassName}>
        <Share2 size={16} />
        Share
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="bg-surface border border-border rounded-2xl w-full max-w-sm animate-slide-up shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-border">
              <div className="flex items-center gap-2">
                <Share2 size={18} className="text-accent-light" />
                <h2 className="font-bold text-white text-lg">Share</h2>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-2">
              <button
                onClick={() => handlePlatformClick("x")}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors text-left"
              >
                <X size={16} className="shrink-0" />X
              </button>
              <button
                onClick={() => handlePlatformClick("telegram")}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors text-left"
              >
                <Send size={16} className="shrink-0" />
                Telegram
              </button>
              <button
                onClick={() => handlePlatformClick("whatsapp")}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors text-left"
              >
                <MessageSquare size={16} className="shrink-0" />
                WhatsApp
              </button>
              {/* No Reddit brand mark ships in lucide-react; reserve the icon
                  slot width so the label still lines up with the other rows. */}
              <button
                onClick={() => handlePlatformClick("reddit")}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors text-left"
              >
                <span className="shrink-0 w-4 h-4" />
                Reddit
              </button>
              <button
                onClick={() => handlePlatformClick("facebook")}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors text-left"
              >
                <Facebook size={16} className="shrink-0" />
                Facebook
              </button>
              <button
                onClick={handleCopy}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors text-left"
              >
                <Link2 size={16} className="shrink-0" />
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
