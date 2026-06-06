"use client";

import { useAppStore } from "@/lib/store";
import { X, Zap } from "lucide-react";

export function BagsToastContainer() {
  const { toasts, removeToast } = useAppStore();

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm w-full">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="animate-slide-up flex items-start gap-3 rounded-xl border p-4 shadow-2xl backdrop-blur-sm"
          style={{
            background:
              toast.type === "bags"
                ? "linear-gradient(135deg, rgba(249,115,22,0.15), rgba(251,146,60,0.1))"
                : toast.type === "error"
                ? "rgba(239,68,68,0.15)"
                : "rgba(124,58,237,0.15)",
            borderColor:
              toast.type === "bags"
                ? "rgba(249,115,22,0.4)"
                : toast.type === "error"
                ? "rgba(239,68,68,0.4)"
                : "rgba(124,58,237,0.4)",
          }}
        >
          {toast.type === "bags" && (
            <div className="mt-0.5 flex-shrink-0 w-7 h-7 bg-bags rounded-full flex items-center justify-center">
              <Zap size={14} className="text-white" />
            </div>
          )}
          <p className="text-sm text-white flex-1 leading-snug">
            {toast.message}
          </p>
          <button
            onClick={() => removeToast(toast.id)}
            className="text-gray-500 hover:text-white flex-shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Persistent badge shown throughout the app */
export function PoweredByBagsBadge() {
  return (
    <div className="inline-flex items-center gap-1.5 bg-bags/10 border border-bags/30 text-bags text-xs font-bold px-2.5 py-1 rounded-full animate-pulse-bags">
      <Zap size={10} />
      Powered by Bags
    </div>
  );
}
