"use client";

import { useMemo, useState } from "react";
import { X, Gift, Copy, ExternalLink, CheckCircle, AlertCircle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { SystemProgram, Transaction, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

interface Props {
  creatorWallet: string;
  memeCaption?: string;
  onClose: () => void;
}

const PRESETS = ["0.01", "0.05", "0.1"] as const;
const EXPLORER_CLUSTER = "devnet";

type TxStatus = "idle" | "sending" | "success" | "error";

function shortWallet(w: string) {
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

// Solana Pay transfer request URL — spec: https://docs.solanapay.com/spec#transfer-request
function buildSolanaPayUrl(recipient: string, amount: string, message: string) {
  const params = new URLSearchParams({ amount, label: "MemeDay", message });
  return `solana:${recipient}?${params}`;
}

export function TipModal({ creatorWallet, memeCaption, onClose }: Props) {
  const [amount, setAmount] = useState("0.01");
  const [copied, setCopied] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");

  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  const isValid = !isNaN(parseFloat(amount)) && parseFloat(amount) > 0;

  const solanaPayUrl = useMemo(
    () =>
      buildSolanaPayUrl(
        creatorWallet,
        isValid ? amount : "0.01",
        memeCaption ? `Tip: ${memeCaption.slice(0, 50)}` : "Tip via MemeDay"
      ),
    [creatorWallet, amount, isValid, memeCaption]
  );

  const handleCopy = async () => {
    await navigator.clipboard.writeText(creatorWallet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSendTip = async () => {
    if (!publicKey || !sendTransaction) {
      window.location.href = solanaPayUrl;
      return;
    }

    try {
      setTxStatus("sending");
      const lamports = Math.round(parseFloat(amount) * LAMPORTS_PER_SOL);
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(creatorWallet),
          lamports,
        })
      );
      const sig = await sendTransaction(transaction, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setTxStatus("success");
      setTimeout(() => setTxStatus("idle"), 3000);
    } catch {
      setTxStatus("error");
      setTimeout(() => setTxStatus("idle"), 3000);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
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
                href={`https://explorer.solana.com/address/${creatorWallet}?cluster=${EXPLORER_CLUSTER}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-accent-light transition-colors"
                title="View on Solana Explorer"
              >
                <ExternalLink size={11} />
              </a>
            </div>
          </div>
        </div>

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
      </div>
    </div>
  );
}
