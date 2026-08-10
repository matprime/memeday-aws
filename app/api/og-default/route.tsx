import { ImageResponse } from "next/og";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#080810",
        }}
      >
        <div
          style={{
            fontSize: 96,
            fontWeight: 900,
            color: "#fff",
            display: "flex",
          }}
        >
          Meme<span style={{ color: "#a855f7" }}>Day</span>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
