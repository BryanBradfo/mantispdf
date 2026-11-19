import type { Config } from "tailwindcss";

const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        display: ['"Oswald Variable"', "Oswald", "Impact", "sans-serif"],
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
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
      },
      animation: {
        shimmer: 'shimmer 1.5s ease-in-out infinite',
        'caret-blink': 'caret-blink 1.1s steps(1) infinite',
      },
      colors: {
        paper: token("paper"),
        surface: token("surface"),
        ink: token("ink"),
        "ink-2": token("ink-2"),
        "ink-3": token("ink-3"),
        line: token("line"),
        "line-strong": token("line-strong"),
        danger: token("danger"),
        // TRANSITIONAL (Tasks 4-6 migrate the ~70 files still using these, Task 6 deletes the keys):
        // every shade is mapped onto the monochrome tokens so un-migrated screens stay legible.
        mantis: {
          50: token("surface"),
          100: token("surface"),
          200: token("line"),
          300: token("line"),
          400: token("line-strong"),
          500: token("ink-2"),
          600: token("ink"),
          700: token("ink"),
          800: token("ink"),
          900: token("ink"),
        },
        accent: {
          DEFAULT: token("ink"),
          soft: token("ink"),
          deep: token("ink"),
        },
      },
      boxShadow: {
        // TRANSITIONAL: no glows any more; kept as no-ops while LicenseDialog still names them.
        glow: "none",
        "glow-lg": "none",
      },
    },
  },
  plugins: [],
} satisfies Config;
