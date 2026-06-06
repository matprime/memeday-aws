"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { X, Zap, TrendingUp, Users, BarChart3, Loader2 } from "lucide-react";
import { Creator } from "@/lib/types";
import { buyCreatorToken, sellCreatorToken } from "@/lib/bags";
import { useAppStore } from "@/lib/store";
import { CreatorAvatar } from "./CreatorAvatar";

interface Props {
  creator: Creator;
  onClose: () => void;
}

type Mode = "buy" | "sell";

export function InvestModal({ creator, onClose }: Props) {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { addToast, emitBagsEvent } = useAppStore();

  const [mode, setMode] = useState<Mode>("buy");
  const [solAmount, setSolAmount] = useState("0.1");
  const [tokenAmount, setTokenAmount] = useState("100");
  const [loading, setLoading] = useState(false);

  const estimatedTokens = Math.floor(
    (parseFloat(solAmount) || 0) / creator.token.price
  );
  const estimatedSol = (
    (parseFloat(tokenAmount) || 0) * creator.token.price * 0.95
  ).toFixed(4);

  const handleBuy = async () => {
    if (!publicKey) {
      setVisible(true);
      return;
    }
    const sol = parseFloat(solAmount);
    if (!sol || sol <= 0) return;

    setLoading(true);
    try {
      const result = await buyCreatorToken(
        creator.bagsProjectId,
        sol,
        publicKey.toBase58()
      );
      const event = {
        type: "token_purchased" as const,
        symbol: creator.token.symbol,
        tokenAmount: result.tokenAmount,
        sol,
      };
      emitBagsEvent(event);
      addToast(
        `Investment made via Bags: ${result.tokenAmount.toLocaleString()} $${creator.token.symbol} for ${sol} SOL`,
        "bags"
      );
      onClose();
    } catch {
      addToast("Transaction failed. Please try again.", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleSell = async () => {
    if (!publicKey) {
      setVisible(true);
      return;
    }
    const amount = parseFloat(tokenAmount);
    if (!amount || amount <= 0) return;

    setLoading(true);
    try {
      const result = await sellCreatorToken(
        creator.bagsProjectId,
        amount,
        publicKey.toBase58()
      );
      const event = {
        type: "token_sold" as const,
        symbol: creator.token.symbol,
        tokenAmount: amount,
        sol: result.solReceived,
      };
      emitBagsEvent(event);
      addToast(
        `Selling made via Bags: ${amount.toLocaleString()} $${creator.token.symbol} → ${result.solReceived} SOL`,
        "bags"
      );
      onClose();
    } catch {
      addToast("Transaction failed. Please try again.", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-2xl w-full max-w-md animate-slide-up shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <CreatorAvatar seed={creator.id ?? creator.username} alt={creator.username} size={40} />
            <div>
              <p className="font-bold text-white">{creator.username}</p>
              <p className="text-xs text-bags font-mono">
                ${creator.token.symbol}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-white/10"
          >
            <X size={18} />
          </button>
        </div>

        {/* Bags banner */}
        <div className="mx-5 mt-4 flex items-center gap-2 bg-bags/10 border border-bags/30 rounded-xl px-4 py-2.5">
          <Zap size={16} className="text-bags flex-shrink-0" />
          <p className="text-xs text-bags font-medium">
            Transaction executed on Solana via{" "}
            <span className="font-bold">Bags</span> protocol
          </p>
        </div>

        {/* Token stats */}
        <div className="grid grid-cols-3 gap-3 mx-5 mt-4">
          {[
            {
              icon: BarChart3,
              label: "Price",
              value: `${creator.token.price} SOL`,
            },
            {
              icon: TrendingUp,
              label: "24h",
              value: `${creator.token.priceChange24h > 0 ? "+" : ""}${creator.token.priceChange24h}%`,
              color:
                creator.token.priceChange24h > 0
                  ? "text-green-400"
                  : "text-red-400",
            },
            {
              icon: Users,
              label: "Holders",
              value: creator.token.holders.toLocaleString(),
            },
          ].map(({ icon: Icon, label, value, color }) => (
            <div
              key={label}
              className="bg-bg/60 rounded-xl p-3 text-center border border-border/50"
            >
              <Icon size={14} className="text-gray-500 mx-auto mb-1" />
              <p className={`text-sm font-bold ${color ?? "text-white"}`}>
                {value}
              </p>
              <p className="text-xs text-gray-500">{label}</p>
            </div>
          ))}
        </div>

        {/* Mode toggle */}
        <div className="flex mx-5 mt-4 bg-bg/60 rounded-xl p-1 border border-border/50">
          {(["buy", "sell"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold capitalize transition-all ${
                mode === m
                  ? m === "buy"
                    ? "bg-green-600 text-white"
                    : "bg-red-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Input */}
        <div className="mx-5 mt-4">
          {mode === "buy" ? (
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">
                Amount in SOL
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={solAmount}
                  onChange={(e) => setSolAmount(e.target.value)}
                  className="flex-1 bg-bg/60 border border-border rounded-xl px-4 py-3 text-white font-mono text-lg focus:outline-none focus:border-accent"
                />
                <div className="flex flex-col gap-1">
                  {["0.1", "0.5", "1"].map((v) => (
                    <button
                      key={v}
                      onClick={() => setSolAmount(v)}
                      className="px-3 py-1 bg-bg/60 border border-border rounded-lg text-xs text-gray-400 hover:text-white hover:border-accent transition-colors"
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                ≈ {estimatedTokens.toLocaleString()} ${creator.token.symbol}{" "}
                tokens
              </p>
            </div>
          ) : (
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">
                Tokens to sell
              </label>
              <input
                type="number"
                min="1"
                value={tokenAmount}
                onChange={(e) => setTokenAmount(e.target.value)}
                className="w-full bg-bg/60 border border-border rounded-xl px-4 py-3 text-white font-mono text-lg focus:outline-none focus:border-accent"
              />
              <p className="text-xs text-gray-500 mt-2">
                ≈ {estimatedSol} SOL received
              </p>
            </div>
          )}
        </div>

        {/* Action button */}
        <div className="p-5">
          {publicKey ? (
            <button
              onClick={mode === "buy" ? handleBuy : handleSell}
              disabled={loading}
              className={`w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-white transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed ${
                mode === "buy"
                  ? "bg-green-600 hover:bg-green-500"
                  : "bg-red-600 hover:bg-red-500"
              }`}
            >
              {loading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Processing via Bags…
                </>
              ) : (
                <>
                  <Zap size={18} />
                  {mode === "buy"
                    ? `Buy $${creator.token.symbol} via Bags`
                    : `Sell $${creator.token.symbol} via Bags`}
                </>
              )}
            </button>
          ) : (
            <button
              onClick={() => setVisible(true)}
              className="w-full py-3.5 rounded-xl font-bold text-white bg-accent hover:bg-accent-light transition-all"
            >
              Connect Wallet to Invest
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
