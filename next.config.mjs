/** @type {import('next').NextConfig} */
const nextConfig = {
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
