"use client";

import { useState } from "react";
import { Zap } from "lucide-react";
import { Creator } from "@/lib/types";
import { InvestModal } from "./InvestModal";

interface Props {
  creator: Creator;
}

export function CreatorInvestButton({ creator }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 bg-bags hover:bg-bags-light text-white font-bold px-5 py-2.5 rounded-xl transition-all hover:scale-105 active:scale-95 animate-pulse-bags"
      >
        <Zap size={16} />
        Invest in this creator
      </button>

      {open && (
        <InvestModal creator={creator} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
