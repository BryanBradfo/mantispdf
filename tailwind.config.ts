import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        mantis: {
          50:  "#f2fde0",
          100: "#e3f9bb",
          200: "#c8f28c",
          300: "#a6e659",
          400: "#87d233",
          500: "#6bbf2e",
          600: "#55991f",
          700: "#407215",
          800: "#32590e",
          900: "#264008",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
