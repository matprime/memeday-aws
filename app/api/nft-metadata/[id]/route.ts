import { NextRequest, NextResponse } from "next/server";
import { getNftMetadata } from "@/lib/db";
import { buildNftMetadataDoc } from "@/lib/nft-shared";

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const row = await getNftMetadata(params.id);
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(
    buildNftMetadataDoc({ name: row.name, description: row.description, image: row.image_url })
  );
}
