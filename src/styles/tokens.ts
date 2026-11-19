/**
 * Single source of truth for the black and white palette (spec 3.1). src/index.css declares the same
 * values as RGB channels (so Tailwind alpha modifiers work); tokens.test.ts ties the two together.
 */
export const TOKENS = {
  dark: {
    paper: "#000000",
    surface: "#0b0b0b",
    ink: "#f2f2f2",
    "ink-2": "#a3a3a3",
    "ink-3": "#6b6b6b",
    line: "#262626",
    "line-strong": "#5c5c5c",
    danger: "#ff5c5c",
  },
  light: {
    paper: "#ffffff",
    surface: "#f7f7f7",
    ink: "#0a0a0a",
    "ink-2": "#525252",
    "ink-3": "#8a8a8a",
    line: "#e5e5e5",
    // Spec said #a3a3a3, which is only 2.5:1 on white; #8a8a8a clears the 3:1 non-text minimum.
    "line-strong": "#8a8a8a",
    danger: "#c62828",
  },
} as const;
