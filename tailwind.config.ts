import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        shimmer: {
          '0%':   { transform: 'translateX(-200%)' },
          '100%': { transform: 'translateX(400%)' },
        },
        'caret-blink': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.55' },
          '50%':      { opacity: '0.9' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%':      { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.5s ease-in-out infinite',
        'caret-blink': 'caret-blink 1.1s steps(1) infinite',
        'glow-pulse': 'glow-pulse 4s ease-in-out infinite',
        float: 'float 6s ease-in-out infinite',
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
        // The single vibrant accent: neon mantis green. Used sparingly for the
        // primary CTA, active dropzone state, and soft glows on the dark UI.
        accent: {
          DEFAULT: "#7CFC4D",
          soft:    "#9dff6e",
          deep:    "#56d62a",
        },
      },
      boxShadow: {
        // Soft accent glows (the "premium" radiance) rather than harsh shadows.
        glow:    "0 0 0 1px rgba(124,252,77,0.18), 0 0 32px -4px rgba(124,252,77,0.35)",
        'glow-lg': "0 0 0 1px rgba(124,252,77,0.30), 0 0 64px -8px rgba(124,252,77,0.55)",
      },
    },
  },
  plugins: [],
} satisfies Config;
