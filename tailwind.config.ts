import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      keyframes: {
        shimmer: {
          '0%':   { transform: 'translateX(-200%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.5s ease-in-out infinite',
      },
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
