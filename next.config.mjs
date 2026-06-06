/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "i.imgflip.com" },
      { protocol: "https", hostname: "api.dicebear.com" },
      { protocol: "https", hostname: "yaclaluunagvsqsyayje.supabase.co" },
    ],
  },
};

export default nextConfig;
