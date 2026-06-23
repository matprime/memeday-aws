import { NextRequest, NextResponse } from "next/server";
import { getNftMetadata } from "@/lib/db";

function imageMimeFromUrl(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const row = await getNftMetadata(params.id);
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    name: row.name,
    symbol: "MDAY",
    description: row.description,
    image: row.image_url,
    properties: {
      files: [{ uri: row.image_url, type: imageMimeFromUrl(row.image_url) }],
      category: "image",
    },
  });
}
