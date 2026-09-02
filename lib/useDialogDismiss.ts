"use client";

import { useEffect, useMemo } from "react";
import { createRefocusGuard, isBackdropClick } from "@/lib/dialogDismiss";

interface Options {
  onClose: () => void;
  // Modals holding user input (PostMemeModal, InvestModal) never close on a
  // backdrop click per KAN-74 — X/Cancel/Escape only.
  closeOnBackdrop: boolean;
  // For modals that stay mounted and toggle visibility internally (ShareBar,
  // the leaderboard memes modal) rather than being conditionally rendered by
  // their parent — skips attaching listeners while closed.
  enabled?: boolean;
}

export function useDialogDismiss({ onClose, closeOnBackdrop, enabled = true }: Options) {
  const guard = useMemo(() => createRefocusGuard(), []);

  useEffect(() => {
    if (!enabled) return;
    const onWindowBlur = () => guard.onBlur();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [guard, onClose, enabled]);

  if (!closeOnBackdrop) return { handleBackdropClick: undefined };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (guard.consume()) return;
    if (isBackdropClick(e.target, e.currentTarget)) onClose();
  };

  return { handleBackdropClick };
}
