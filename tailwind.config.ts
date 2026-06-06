import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#080810",
        surface: "#0f0f1a",
        border: "#1e1e2e",
        accent: "#7c3aed",
        "accent-light": "#a855f7",
        bags: "#f97316",
        "bags-light": "#fb923c",
        hot: "#ef4444",
        gold: "#eab308",
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "bags-gradient": "linear-gradient(135deg, #f97316 0%, #fb923c 100%)",
        "hero-gradient":
          "linear-gradient(135deg, #7c3aed 0%, #a855f7 50%, #f97316 100%)",
      },
      animation: {
        "fade-in": "fadeIn 0.3s ease-in-out",
        "slide-up": "slideUp 0.3s ease-out",
        "pulse-bags": "pulseBags 2s ease-in-out infinite",
        "spike": "spike 0.5s ease-out",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseBags: {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(249,115,22,0.4)" },
          "50%": { boxShadow: "0 0 0 8px rgba(249,115,22,0)" },
        },
        spike: {
          "0%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.08)" },
          "100%": { transform: "scale(1)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
