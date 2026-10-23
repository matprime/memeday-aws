"use client";

import { useEffect, useState } from "react";
import { Zap, ExternalLink, Loader2 } from "lucide-react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useAppStore } from "@/lib/store";
import { getAccessToken } from "@/lib/session";
import { buildBagsLaunchIntentUrl, extractBagsTokenMint, BagsLaunchConfigError } from "@/lib/bags";
import { BagsTokenCard } from "@/components/BagsTokenCard";
import { EVENTS, track } from "@/lib/analytics";
import {
  BAGS_LAUNCH_MIN_SOL,
  isBelowBagsLaunchMin,
  saveBagsLaunchDraft,
  loadBagsLaunchDraft,
  clearBagsLaunchDraft,
} from "@/lib/bags-launch-draft";

interface Props {
  // The meme this token belongs to. A token is bound to one meme and only its
  // uploader may bind it (KAN-11), so every launch and every claim names one.
  memeId: string;
  imageUrl: string;
  defaultName: string;
  // Shows the paste-the-mint panel without waiting for a launch to be started
  // here (KAN-79 recovery): the meme page is where a creator comes back after
  // bags.fm interrupted them, and the tab that opened the launch is long gone.
  alwaysShowClaim?: boolean;
}

interface TokenSummary {
  tokenMint: string;
  name: string;
  symbol: string;
}

// Shown after a meme posts successfully (see PostMemeModal). Launching is a
// pure link-out on mainnet — no transaction is ever signed inside MemeDay —
// and a simulated no-op everywhere else (KAN-29 follow-up, correction 1):
// GET /api/bags/launch-config and POST /api/bags/verify decide live vs mock
// server-side, this component just renders whichever they hand back.
export function BagsLaunchClaim({ memeId, imageUrl, defaultName, alwaysShowClaim }: Props) {
  const { addToast } = useAppStore();
  const { publicKey } = useWallet();
  const { connection } = useConnection();

  // Whether this meme already has a verified token drives launch-button vs
  // card. null = still checking.
  const [existingToken, setExistingToken] = useState<TokenSummary | null | undefined>(undefined);

  const [name, setName] = useState(defaultName.slice(0, 32));
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState(defaultName);
  const [launching, setLaunching] = useState(false);

  // Live-mode-only claim step: paste the mint you got from bags.fm.
  const [awaitingMint, setAwaitingMint] = useState(false);
  const [mintAddress, setMintAddress] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Shown inline before Launch is clicked: a toast raised just before
  // window.open is never seen, since the browser has already moved to the
  // bags.fm tab. Warn only. The creator may fund a different wallet there.
  const [balanceLamports, setBalanceLamports] = useState<number | null>(null);

  useEffect(() => {
    setBalanceLamports(null);
  }, [publicKey]);

  // Re-read on tab focus, and every 15s while the warning is showing, so
  // topping up the wallet clears it without a reload. Polling stops once the
  // balance is at or above the minimum.
  const balanceLow = balanceLamports !== null && isBelowBagsLaunchMin(balanceLamports);
  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;
    const read = () => {
      connection
        .getBalance(publicKey)
        .then((balance) => {
          if (!cancelled) setBalanceLamports(balance);
        })
        .catch((err) => {
          console.error("Bags launch balance check failed", err);
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    read();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", onVisible);
    const timer = balanceLow ? setInterval(read, 15_000) : undefined;
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearInterval(timer);
    };
  }, [publicKey, connection, balanceLow]);

  // Restore what the creator typed before bags.fm took them away. Runs after
  // mount (not in the useState initializers) so server and client markup match.
  useEffect(() => {
    const draft = loadBagsLaunchDraft(memeId);
    if (!draft) return;
    if (draft.name !== undefined) setName(draft.name.slice(0, 32));
    if (draft.ticker !== undefined) setTicker(draft.ticker);
    if (draft.description !== undefined) setDescription(draft.description);
  }, [memeId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) return;
        const res = await fetch(`/api/bags/my-token?memeId=${encodeURIComponent(memeId)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setExistingToken(data.token ?? null);
      } catch {
        // Leave existingToken as undefined -> falls through to the launch
        // form below rather than blocking the whole success screen on this.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memeId]);

  const verify = async (tokenMint?: string) => {
    setVerifying(true);
    setVerifyError(null);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Session expired — sign in again");

      const res = await fetch("/api/bags/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ memeId, tokenMint, name, symbol: ticker }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Verification failed");

      clearBagsLaunchDraft(memeId);
      setExistingToken({ tokenMint: data.token.tokenMint, name: data.token.name, symbol: data.token.symbol });
      track(EVENTS.bagsVerifyConfirmed, { simulated: data.simulated, tokenMint: data.token.tokenMint });
      addToast(
        data.simulated
          ? "Simulated launch verified (Preview only — no real token exists)."
          : "Verified — your Bags launch is now on your profile.",
        data.simulated ? "bags" : "success"
      );
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setVerifying(false);
    }
  };

  // Runs a pasted mint or bags.fm link through extractBagsTokenMint before
  // ever calling verify, in both launch and claim-only mode (KAN-79).
  const handleVerifyMint = () => {
    const mint = extractBagsTokenMint(mintAddress);
    if (!mint) {
      setVerifyError("That doesn't look like a valid mint address or bags.fm link.");
      return;
    }
    track(EVENTS.bagsVerifyStarted);
    verify(mint);
  };

  const handleLaunch = async () => {
    if (!ticker.trim() || !name.trim() || launching) return;
    saveBagsLaunchDraft(memeId, { name, ticker, description });
    setLaunching(true);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Session expired — sign in again");

      const configRes = await fetch("/api/bags/launch-config", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!configRes.ok) throw new Error("Could not reach MemeDay");
      const config = await configRes.json();

      // Wallet-only gate (KAN-75): checked before either branch below, so it
      // applies in simulated mode too, not just the live bags.fm link-out.
      if (!config.walletAuthed) {
        throw new Error("Connect and verify a wallet to launch a Bags token");
      }

      track(EVENTS.bagsLaunchStarted, { mode: config.live ? "live" : "simulated" });

      if (!config.live) {
        // Mock path: no bags.fm tab, no Bags API call. Goes straight to a
        // simulated verify result so the flow stays reviewable on Preview.
        await verify(undefined);
        return;
      }

      const url = buildBagsLaunchIntentUrl({
        name,
        ticker,
        description: description.trim() || undefined,
        image: imageUrl,
        partner: config.partnerWallet,
        partnerConfig: config.partnerConfig,
      });
      window.open(url, "_blank", "noopener,noreferrer");
      setAwaitingMint(true);
    } catch (err) {
      addToast(
        err instanceof BagsLaunchConfigError || err instanceof Error
          ? err.message
          : "Could not open the Bags launch flow",
        "error"
      );
    } finally {
      setLaunching(false);
    }
  };

  if (existingToken === undefined) {
    return (
      <div className="flex items-center justify-center py-6 text-gray-500">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  if (existingToken) {
    return <BagsTokenCard name={existingToken.name} symbol={existingToken.symbol} tokenMint={existingToken.tokenMint} />;
  }

  return (
    <div className="space-y-4">
      <div className="bg-bags/10 border border-bags/30 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap size={16} className="text-bags" />
          <p className="text-sm font-bold text-bags">Launch a Creator Token on Bags</p>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          Opens bags.fm in a new tab with your meme&apos;s image and details prefilled. You
          connect and sign on Bags — MemeDay never holds your keys or signs anything here.
        </p>

        <div className="space-y-2 mb-3">
          <div>
            <label htmlFor="bags-token-name" className="text-xs text-gray-400 mb-1.5 block font-medium">
              Token name
            </label>
            <input
              id="bags-token-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 32))}
              placeholder="Token name"
              maxLength={32}
              className="w-full bg-bg/80 border border-bags/30 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-bags placeholder:text-gray-600"
            />
          </div>
          <div>
            <label htmlFor="bags-token-ticker" className="text-xs text-gray-400 mb-1.5 block font-medium">
              Ticker
            </label>
            <input
              id="bags-token-ticker"
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))}
              placeholder="Ticker (2-10 chars, e.g. MLRD)"
              maxLength={10}
              className="w-full bg-bg/80 border border-bags/30 rounded-xl px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-bags placeholder:text-gray-600"
            />
          </div>
          <div>
            <label htmlFor="bags-token-description" className="text-xs text-gray-400 mb-1.5 block font-medium">
              Description
            </label>
            <input
              id="bags-token-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              className="w-full bg-bg/80 border border-bags/30 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-bags placeholder:text-gray-600"
            />
          </div>
        </div>

        {/* Required disclosure, shown before the user can leave for bags.fm. The
            partner cut comes off Bags' own platform fee, not the creator's —
            see lib/bags-server.ts getPartnerAttribution for how that's verified. */}
        <p className="text-xs text-gray-500 mb-3">
          MemeDay is a Bags launch partner and receives a share of Bags&apos; platform fee on
          tokens launched through this link. This does not reduce your own creator fees.
        </p>
        <p className="text-xs text-gray-500 mb-3">
          A launch on bags.fm needs a bags.fm account and some SOL for fees, so set those up
          before clicking Launch.
        </p>

        {balanceLamports !== null && balanceLow && (
          <p className="text-xs text-amber-400 mb-3">
            Your wallet holds {(balanceLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL. A launch on
            bags.fm needs about {BAGS_LAUNCH_MIN_SOL} SOL for fees.
          </p>
        )}

        <button
          onClick={handleLaunch}
          disabled={!ticker.trim() || !name.trim() || launching || verifying}
          className="w-full py-2.5 rounded-xl font-bold text-white bg-bags hover:bg-bags-light disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
        >
          {launching || verifying ? <Loader2 size={16} className="animate-spin" /> : <ExternalLink size={16} />}
        Launch on Bags
      </button>
      </div>

      {/* On the meme page this panel is always open: that is where a creator
          comes back after bags.fm interrupted them, and the tab that opened
          the launch is gone. On the success screen it waits until a launch
          has actually been started here (KAN-79). */}
      {(alwaysShowClaim || awaitingMint) && (
        <div className="bg-bg/60 border border-border/50 rounded-xl p-4">
          <p className="text-sm font-semibold text-white mb-1">
            {awaitingMint ? "Launched your token?" : "Already launched on bags.fm?"}
          </p>
          <p className="text-xs text-gray-400 mb-3">
            Paste your token address here so MemeDay can verify and show it on your profile.
          </p>
          <p className="text-xs text-gray-500 mb-3">
            This binding is permanent and cannot be changed later.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={mintAddress}
              onChange={(e) => setMintAddress(e.target.value)}
              placeholder="Token mint address or bags.fm link"
              className="flex-1 bg-bg/80 border border-border rounded-xl px-4 py-2.5 text-white font-mono text-xs focus:outline-none focus:border-accent placeholder:text-gray-600"
            />
            <button
              onClick={handleVerifyMint}
              disabled={!mintAddress.trim() || !ticker.trim() || !name.trim() || verifying}
              className="px-4 py-2.5 rounded-xl font-bold text-white bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {verifying ? <Loader2 size={16} className="animate-spin" /> : "Verify"}
            </button>
          </div>
          {verifyError && <p className="text-xs text-red-400 mt-2">{verifyError}</p>}
        </div>
      )}
    </div>
  );
}
