/** CSS approximations of editor paint and fonts (no web fonts are downloaded). */
import { ascent } from "../../lib/editor/afm";
import type { Rgb, StdFont } from "../../lib/editor/model";

const FAMILY: Record<StdFont, string> = {
  Helvetica: "Helvetica, Arial, sans-serif",
  "Helvetica-Bold": "Helvetica, Arial, sans-serif",
  "Times-Roman": '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};

export function cssFont(font: StdFont): { family: string; weight: number } {
  return { family: FAMILY[font], weight: font === "Helvetica-Bold" ? 700 : 400 };
}

const channel = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

export function cssColor([r, g, b]: Rgb): string {
  return `rgb(${channel(r)} ${channel(g)} ${channel(b)})`;
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => channel(v).toString(16).padStart(2, "0")).join("")}`;
}

/** `#rrggbb` to channels in 0..1 (black for anything else). */
export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/**
 * Ascent and descent (em) of the CSS fonts standing in for each standard font (Arial, Times New
 * Roman, Courier New and their usual metric-compatible substitutes: Liberation, Arimo, Tinos).
 */
export const CSS_FONT_METRICS: Record<StdFont, { ascent: number; descent: number }> = {
  Helvetica: { ascent: 0.905, descent: 0.212 },
  "Helvetica-Bold": { ascent: 0.905, descent: 0.212 },
  "Times-Roman": { ascent: 0.891, descent: 0.216 },
  Courier: { ascent: 0.833, descent: 0.3 },
};

/**
 * Vertical shift (em, negative is up) that puts a textarea's first baseline where the engine puts
 * it: `ascent * size / 1000` below the box top. CSS places it half the leading plus the font
 * ascent below the top of the line box.
 */
export function textareaBaselineShift(font: StdFont, lineHeight: number): number {
  const { ascent: a, descent: d } = CSS_FONT_METRICS[font];
  const cssBaseline = (lineHeight - (a + d)) / 2 + a;
  return ascent(font) / 1000 - cssBaseline;
}
