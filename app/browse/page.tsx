import { getFeedPage } from "@/lib/db";
import { BrowseClient } from "@/components/BrowseClient";
import { Tab } from "@/lib/types";
import { LayoutGrid } from "lucide-react";

export const dynamic = "force-dynamic";

const VALID_RANGES: Tab[] = ["today", "week", "all"];

interface Props {
  searchParams: Promise<{ range?: string; cursor?: string }>;
}

export default async function BrowsePage({ searchParams }: Props) {
  const params = await searchParams;
  const range: Tab = VALID_RANGES.includes(params.range as Tab)
    ? (params.range as Tab)
    : "week";
  const { memes, nextCursor } = await getFeedPage(range, params.cursor);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        <LayoutGrid size={24} className="text-accent-light" />
        <h1 className="text-2xl font-black text-white">Browse Memes</h1>
        <span className="text-sm text-gray-500">— no login required to browse</span>
      </div>
      <BrowseClient memes={memes} range={range} nextCursor={nextCursor} />
    </div>
  );
}
