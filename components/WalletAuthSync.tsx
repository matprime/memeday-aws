"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAppStore } from "@/lib/store";
import { EVENTS, track } from "@/lib/analytics";

// Triggers Cognito auth automatically whenever Phantom connects.
// Clears the token when the wallet disconnects.
export function WalletAuthSync() {
  const { publicKey, signMessage, connected, disconnect, wallet } = useWallet();
  const { cognitoToken, setCognitoToken, addToast } = useAppStore();
  const authInFlight = useRef(false);
  const prevWalletNameRef = useRef<string | null>(null);
  // `connected` starts false and only flips true once wallet-adapter's
  // autoConnect finishes reconnecting Phantom (async, on mount). Without this
  // guard the disconnect-clear branch below fires on that transient initial
  // false and wipes a persisted session before autoConnect gets a chance to
  // restore it.
  const hasConnectedRef = useRef(false);

  // Show feedback when user selects a wallet that isn't installed.
  // WalletProviderBase silently skips connect() for NotDetected wallets — onError never fires.
  useEffect(() => {
    if (!wallet) {
      prevWalletNameRef.current = null;
      return;
    }
    if (wallet.readyState === "NotDetected" && wallet.adapter.name !== prevWalletNameRef.current) {
      addToast(`${wallet.adapter.name} not detected — install the extension and reload.`, "error");
    }
    prevWalletNameRef.current = wallet.adapter.name;
  }, [wallet?.adapter.name, wallet?.readyState]);

  useEffect(() => {
    if (!connected) {
      // Only clear wallet-established sessions — an email session survives
      // a wallet disconnect. Skip until we've seen a real connect, so the
      // pre-autoConnect transient false doesn't wipe a persisted session.
      if (hasConnectedRef.current && useAppStore.getState().authMethod === "wallet") {
        setCognitoToken(null);
      }
      return;
    }
    hasConnectedRef.current = true;

    if (!publicKey || !signMessage || cognitoToken || authInFlight.current) return;

    authInFlight.current = true;

    (async () => {
      try {
        const walletAddress = publicKey.toBase58();

        // 1. Get a server-issued challenge (signed nonce)
        const nonceRes = await fetch("/api/auth/wallet/nonce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress }),
        });
        if (!nonceRes.ok) {
          throw new Error(nonceRes.status === 429 ? "Slow down and try again" : "Failed to get auth challenge");
        }
        const { challenge } = await nonceRes.json();

        // 2. Sign the challenge with Phantom (prompts user once on connect)
        const msgBytes = new TextEncoder().encode(challenge);
        const sigBytes = await signMessage(msgBytes);
        const signature = Buffer.from(sigBytes).toString("base64");

        // 3. Verify signature + get Cognito access token
        const verifyRes = await fetch("/api/auth/wallet/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress, challenge, signature }),
        });
        if (!verifyRes.ok) {
          throw new Error(verifyRes.status === 429 ? "Slow down and try again" : "Auth verification failed");
        }
        const { accessToken, isNewUser } = await verifyRes.json();

        // Don't overwrite an email session that completed while wallet auth was in flight
        if (!useAppStore.getState().cognitoToken) {
          setCognitoToken(accessToken, "wallet");
          if (isNewUser) track(EVENTS.signupCompleted, { method: "wallet" });
        }
      } catch (err) {
        addToast(
          err instanceof Error ? err.message : "Wallet authentication failed",
          "error"
        );
        disconnect().catch(() => {});
      } finally {
        authInFlight.current = false;
      }
    })();
  }, [connected, publicKey, signMessage]);

  return null;
}
