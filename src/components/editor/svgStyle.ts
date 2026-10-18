/** CSS approximations of editor paint and fonts (no web fonts are downloaded). */
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
