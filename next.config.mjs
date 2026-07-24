/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Force-dynamic pages (Home) are already live server-side (noStore()).
    // Default staleTimes.dynamic=30s lets the client Router Cache serve a
    // stale Home RSC payload after posting a meme from another route.
    staleTimes: { dynamic: 0 },
  },
  images: {
    unoptimized: process.env.NODE_ENV === "development",
    remotePatterns: [
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "i.imgflip.com" },
      { protocol: "https", hostname: "api.dicebear.com" },
      ...(process.env.CLOUDFRONT_DOMAIN
        ? [{ protocol: "https", hostname: process.env.CLOUDFRONT_DOMAIN }]
        : []),
    ],
  },
};

export default nextConfig;
