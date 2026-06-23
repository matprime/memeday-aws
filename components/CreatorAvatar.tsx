"use client";

import React from "react";

type Shape = "circle" | "square";

function dicebearPngUrl(seed: string, size: number) {
  const params = new URLSearchParams({
    seed,
    size: String(size),
    // Provide a palette so we don't get transparent/blank looking avatars.
    backgroundColor: "b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf",
  });

  // PNG is more reliable than SVG with various image pipelines.
  return `https://api.dicebear.com/8.x/bottts/png?${params.toString()}`;
}

export function CreatorAvatar({
  seed,
  alt,
  size = 40,
  shape = "circle",
  className = "",
}: {
  seed: string;
  alt: string;
  size?: number;
  shape?: Shape;
  className?: string;
}) {
  const roundedClass = shape === "circle" ? "rounded-full" : "rounded-lg";
  const url = dicebearPngUrl(seed, size);

  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      className={`${roundedClass} bg-gray-800 object-cover shrink-0 ${className}`}
      onError={(e) => {
        // If Dicebear is blocked/offline, show a simple fallback background.
        (e.currentTarget as HTMLImageElement).src =
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='100%25' height='100%25' fill='%231f2937'/%3E%3C/svg%3E";
      }}
    />
  );
}

