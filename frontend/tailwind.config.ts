import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["'Barlow'", "'D-DIN-Bold'", "Arial", "Verdana", "sans-serif"],
        body: ["'Barlow'", "'D-DIN'", "Arial", "Verdana", "sans-serif"],
        mono: ["'IBM Plex Mono'", "monospace"],
      },
      colors: {
        "space-black": "#000000",
        "spectral": "#f0f0fa",
      },
    },
  },
  plugins: [],
};

export default config;
