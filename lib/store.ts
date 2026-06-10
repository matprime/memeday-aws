"use client";

import { create } from "zustand";
import { BagsEvent } from "./types";

interface Toast {
  id: string;
  message: string;
  type: "bags" | "success" | "error";
}

interface AppState {
  // Toasts / notifications
  toasts: Toast[];
  addToast: (message: string, type?: Toast["type"]) => void;
  removeToast: (id: string) => void;

  // Bags event stream
  lastBagsEvent: BagsEvent | null;
  emitBagsEvent: (event: BagsEvent) => void;

  // Cognito session — set after a successful Cognito auth (email or wallet custom-auth)
  cognitoToken: string | null;
  setCognitoToken: (token: string | null) => void;

  // Optimistic votes (client-side, keyed by userId for persistence)
  votedMemes: Set<string>;
  hydrateVotedMemes: (userId: string | null) => void;
  voteOnMeme: (userId: string | null, memeId: string) => void;

  // Creator project state (per session)
  myBagsProjectId: string | null;
  myTokenSymbol: string | null;
  setMyBagsProject: (projectId: string, tokenSymbol: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  toasts: [],
  addToast: (message, type = "success") => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => get().removeToast(id), 5000);
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  lastBagsEvent: null,
  emitBagsEvent: (event) => {
    set({ lastBagsEvent: event });
  },

  cognitoToken: null,
  setCognitoToken: (token) => set({ cognitoToken: token }),

  votedMemes: new Set(),
  hydrateVotedMemes: (userId) => {
    if (!userId) {
      set({ votedMemes: new Set() });
      return;
    }
    try {
      const raw = localStorage.getItem(`votedMemes:${userId}`);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      const ids = Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
      set({ votedMemes: new Set(ids) });
    } catch {
      set({ votedMemes: new Set() });
    }
  },
  voteOnMeme: (userId, memeId) =>
    set((s) => {
      const next = new Set(s.votedMemes);
      next.add(memeId);
      if (userId) {
        try {
          localStorage.setItem(`votedMemes:${userId}`, JSON.stringify(Array.from(next)));
        } catch {
          // ignore storage errors (private mode / quota)
        }
      }
      return { votedMemes: next };
    }),

  myBagsProjectId: null,
  myTokenSymbol: null,
  setMyBagsProject: (projectId, tokenSymbol) =>
    set({ myBagsProjectId: projectId, myTokenSymbol: tokenSymbol }),
}));
