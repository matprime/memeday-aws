import { getMemes } from "@/lib/db";
import { BrowseClient } from "@/components/BrowseClient";
import { LayoutGrid } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function BrowsePage() {
  const memes = await getMemes();

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        <LayoutGrid size={24} className="text-accent-light" />
        <h1 className="text-2xl font-black text-white">Browse Memes</h1>
        <span className="text-sm text-gray-500">— no login required to browse</span>
      </div>
      <BrowseClient memes={memes} />
    </div>
  );
}
