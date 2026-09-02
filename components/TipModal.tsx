"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X, Gift, Copy, ExternalLink, CheckCircle, AlertCircle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  Keypair,
} from "@solana/web3.js";
import { EVENTS, track } from "@/lib/analytics";
import { useSolanaConfig } from "./WalletProvider";
import {
  buildSolanaPayUrl,
  classifyTipError,
  validateAmount,
} from "@/lib/solana/tip";
import { pollSignatureConfirmation } from "@/lib/solana/confirm";
import { useDialogDismiss } from "@/lib/useDialogDismiss";

interface Props {
  creatorWallet: string;
  memeId?: string;
  memeCaption?: string;
  onClose: () => void;
}

const PRESETS = ["0.01", "0.05", "0.1"] as const;

// Headroom for the signature fee so the pre-flight check doesn't wave through a
// tip that then fails on-chain for being a few lamports short.
const FEE_BUFFER_LAMPORTS = 10_000;

type TxStatus = "idle" | "sending" | "success" | "error";

function shortWallet(w: string) {
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

export function TipModal({ creatorWallet, memeId, memeCaption, onClose }: Props) {
  const { explorerCluster, enabled, disabledMessage } = useSolanaConfig();
  const [amount, setAmount] = useState("0.01");
  const [copied, setCopied] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);

  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  const { handleBackdropClick } = useDialogDismiss({ onClose, closeOnBackdrop: true });

  const amountCheck = validateAmount(amount);
  const isValid = amountCheck.level !== "block";

  // One throwaway pubkey per modal open, deliberately not keyed on the amount:
  // it must stay stable while the user edits, so the QR they eventually scan
  // carries the same reference that the on-chain transaction does.
  const reference = useMemo(() => Keypair.generate().publicKey, []);

  const solanaPayUrl = useMemo(
    () =>
      buildSolanaPayUrl(
        creatorWallet,
        isValid ? amount : "0.01",
        memeCaption ? `Tip: ${memeCaption.slice(0, 50)}` : "Tip via MemeDay",
        reference.toBase58()
      ),
    [creatorWallet, amount, isValid, memeCaption, reference]
  );

  // Once per modal open, not per amount change — the QR is the funnel step,
  // and re-firing on every keystroke would inflate it.
  const qrTracked = useRef(false);
  useEffect(() => {
    if (!isValid || qrTracked.current) return;
    qrTracked.current = true;
    track(EVENTS.tipQrShown, { memeId });
  }, [isValid, memeId]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(creatorWallet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSendTip = async () => {
    if (!enabled) return;
    if (amountCheck.level === "block") return;

    if (!publicKey || !sendTransaction) {
      track(EVENTS.tipLinkOpened, { memeId, amountSol: parseFloat(amount) });
      window.location.href = solanaPayUrl;
      return;
    }

    setErrorMsg(null);
    setTxSig(null);

    try {
      setTxStatus("sending");
      const lamports = Math.round(parseFloat(amount) * LAMPORTS_PER_SOL);

      // Recipient is validated before the balance call so an unusable creator
      // wallet is reported as such rather than as a funding problem.
      const recipient = new PublicKey(creatorWallet);

      // Pre-flight: catching this here gives an exact figure, which the raw
      // on-chain "insufficient lamports" error can't.
      const balance = await connection.getBalance(publicKey);
      if (balance < lamports + FEE_BUFFER_LAMPORTS) {
        const needed = (lamports + FEE_BUFFER_LAMPORTS) / LAMPORTS_PER_SOL;
        setErrorMsg(
          `Not enough SOL — you need about ${needed.toFixed(4)} SOL including fees, ` +
            `and your wallet holds ${(balance / LAMPORTS_PER_SOL).toFixed(4)}.`
        );
        setTxStatus("error");
        return;
      }

      const instruction = SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: recipient,
        lamports,
      });
      // Same reference as the QR, as a read-only non-signer key: it does
      // nothing on-chain but makes the tip findable on an explorer afterwards.
      instruction.keys.push({
        pubkey: reference,
        isSigner: false,
        isWritable: false,
      });

      const transaction = new Transaction().add(instruction);
      const sig = await sendTransaction(transaction, connection);
      setTxSig(sig);

      // Polling rather than connection.confirmTransaction: the endpoint is our
      // /api/rpc proxy, which cannot serve the WebSocket that confirmation
      // would otherwise subscribe to. See lib/solana/confirm.ts.
      await pollSignatureConfirmation(connection, sig, "confirmed");
      setTxStatus("success");
    } catch (err) {
      const { kind, message } = classifyTipError(err);
      if (kind === "cancelled") {
        // A deliberate cancel isn't a failure — return quietly to the form.
        setTxStatus("idle");
        return;
      }
      setErrorMsg(message);
      setTxStatus("error");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="bg-surface border border-border rounded-2xl w-full max-w-sm animate-slide-up shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-2">
            <Gift size={18} className="text-accent-light" />
            <h2 className="font-bold text-white text-lg">Tip Creator</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {!enabled ? (
          <div className="p-5">
            <div className="flex items-center gap-2 bg-yellow-900/20 border border-yellow-700/40 rounded-xl px-4 py-3 text-sm text-yellow-400">
              <AlertCircle size={16} />
              {disabledMessage}
            </div>
          </div>
        ) : (
        <div className="p-5 space-y-4">
          {/* Amount selector */}
          <div>
            <label className="text-xs text-gray-400 mb-1.5 block font-medium">
              Tip Amount (SOL)
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="flex-1 bg-bg/60 border border-border rounded-xl px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-accent"
              />
              {PRESETS.map((v) => (
                <button
                  key={v}
                  onClick={() => setAmount(v)}
                  className={`shrink-0 min-w-[3rem] px-2 py-1 rounded-lg text-xs font-mono transition-colors border whitespace-nowrap text-center ${
                    amount === v
                      ? "border-accent text-accent-light bg-accent/10"
                      : "border-border text-gray-400 hover:text-white hover:border-accent/50"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            {amountCheck.message && (
              <p className="mt-1.5 text-xs text-red-400">{amountCheck.message}</p>
            )}
          </div>

          {/* QR code — white background required for scanner contrast */}
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-gray-400">Scan with any Solana wallet</p>
            <div className="bg-white p-3 rounded-xl">
              {isValid ? (
                <QRCodeSVG
                  value={solanaPayUrl}
                  size={200}
                  level="H"
                  includeMargin={false}
                />
              ) : (
                <div className="w-[200px] h-[200px] flex items-center justify-center">
                  <p className="text-gray-400 text-xs text-center px-4">
                    Enter a valid SOL amount above
                  </p>
                </div>
              )}
            </div>
            <p className="text-[10px] text-gray-600 text-center">
              Works with Phantom · Backpack · Solflare · and more
            </p>
          </div>

          {/* Wallet address row */}
          <div className="flex items-center justify-between bg-bg/60 border border-border/50 rounded-xl px-4 py-2.5">
            <span className="text-xs text-gray-300 font-mono tracking-wide">
              {shortWallet(creatorWallet)}
            </span>
            <div className="flex items-center gap-3">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors"
              >
                <Copy size={11} />
                {copied ? "Copied!" : "Copy"}
              </button>
              <a
                href={`https://explorer.solana.com/address/${creatorWallet}?cluster=${explorerCluster}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-accent-light transition-colors"
                title="View on Solana Explorer"
              >
                <ExternalLink size={11} />
              </a>
            </div>
          </div>

          {errorMsg && (
            <div className="flex items-start gap-2 bg-red-900/20 border border-red-700/40 rounded-xl px-4 py-3 text-xs text-red-300">
              <AlertCircle size={14} className="mt-px shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {txSig && txStatus === "success" && (
            <a
              href={`https://explorer.solana.com/tx/${txSig}?cluster=${explorerCluster}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 text-xs text-accent-light hover:underline"
            >
              <ExternalLink size={11} />
              View transaction
            </a>
          )}
        </div>
        )}

        {enabled && (
        <div className="px-5 pb-5">
          <button
            onClick={handleSendTip}
            disabled={!isValid || txStatus === "sending"}
            className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-white transition-all text-sm ${
              txStatus === "success"
                ? "bg-green-600 hover:bg-green-600"
                : txStatus === "error"
                ? "bg-red-600 hover:bg-red-600"
                : "bg-accent hover:bg-accent-light hover:scale-[1.02] active:scale-[0.98]"
            } disabled:opacity-60 disabled:cursor-not-allowed disabled:scale-100`}
          >
            {txStatus === "sending" ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Sending…
              </>
            ) : txStatus === "success" ? (
              <>
                <CheckCircle size={16} />
                Tip Sent!
              </>
            ) : txStatus === "error" ? (
              <>
                <AlertCircle size={16} />
                Failed — Try Again
              </>
            ) : (
              <>
                <Gift size={16} />
                Send Tip
              </>
            )}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
