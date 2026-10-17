import { resolveEngineTokens, substituteJsTokens, type Anchor, type StampJobSpec, type StdFont, type TextStampSpec } from "./stampJob";

export interface TextStyle {
  font: StdFont;
  size: number;
  /** "#rrggbb" */
  color: string;
  /** 0..1 */
  opacity: number;
}

export const DEFAULT_STYLE: TextStyle = { font: "Helvetica", size: 11, color: "#000000", opacity: 1 };
export const DEFAULT_MARGIN = 28;

export const PAGE_NUMBER_PRESETS = [
  { id: "n", label: "1", template: "{n}" },
  { id: "page-n", label: "Page 1", template: "Page {n}" },
  { id: "n-total", label: "1 / 12", template: "{n} / {total}" },
  { id: "page-n-of", label: "Page 1 of 12", template: "Page {n} of {total}" },
] as const;

export const ANCHOR_LABELS: Record<Anchor, string> = {
  "top-left": "Top left",
  "top-center": "Top center",
  "top-right": "Top right",
  "middle-left": "Middle left",
  center: "Center",
  "middle-right": "Middle right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom center",
  "bottom-right": "Bottom right",
};

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function todayIso(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export interface JobContext {
  total: number;
  /** Selected 1-based pages. */
  pages: readonly number[];
  filename: string;
  date: string;
}

function pagesSpec(pages: readonly number[], total: number): number[] | "all" {
  return pages.length === total ? "all" : [...pages];
}

function textSpec(template: string, anchor: Anchor, style: TextStyle, margin: number): TextStampSpec {
  return {
    template,
    font: style.font,
    size: style.size,
    color: hexToRgb(style.color),
    opacity: style.opacity,
    anchor,
    marginX: margin,
    marginY: margin,
  };
}

export interface PageNumberSettings {
  anchor: Anchor;
  template: string;
  numberStart: number;
  style: TextStyle;
  margin: number;
}

export function buildPageNumberJob(s: PageNumberSettings, ctx: JobContext): StampJobSpec {
  const template = substituteJsTokens(s.template, ctx);
  return {
    pages: pagesSpec(ctx.pages, ctx.total),
    texts: [textSpec(template, s.anchor, s.style, s.margin)],
    images: [],
    numberStart: s.numberStart,
  };
}

export const HEADER_FOOTER_SLOTS = [
  { anchor: "top-left", label: "Header left" },
  { anchor: "top-center", label: "Header center" },
  { anchor: "top-right", label: "Header right" },
  { anchor: "bottom-left", label: "Footer left" },
  { anchor: "bottom-center", label: "Footer center" },
  { anchor: "bottom-right", label: "Footer right" },
] as const satisfies readonly { anchor: Anchor; label: string }[];

export type HeaderFooterSlots = Record<(typeof HEADER_FOOTER_SLOTS)[number]["anchor"], string>;

export interface HeaderFooterSettings {
  slots: HeaderFooterSlots;
  style: TextStyle;
  margin: number;
}

/** Returns null when every slot is blank (nothing to stamp). */
export function buildHeaderFooterJob(s: HeaderFooterSettings, ctx: JobContext): StampJobSpec | null {
  const texts = HEADER_FOOTER_SLOTS.filter((slot) => s.slots[slot.anchor].trim() !== "").map((slot) =>
    textSpec(substituteJsTokens(s.slots[slot.anchor], ctx), slot.anchor, s.style, s.margin),
  );
  if (texts.length === 0) return null;
  return { pages: pagesSpec(ctx.pages, ctx.total), texts, images: [], numberStart: 1 };
}

/**
 * Numbers printed on the first and last selected pages, as the engine computes them:
 * {n} = numberStart + (page - first selected page), {total} = the number on the last selected page.
 */
export function pageNumberRange(numberStart: number, pages: readonly number[]): { first: number; last: number } {
  if (pages.length === 0) return { first: numberStart, last: numberStart };
  const lo = pages.reduce((a, b) => Math.min(a, b));
  const hi = pages.reduce((a, b) => Math.max(a, b));
  return { first: numberStart, last: numberStart + (hi - lo) };
}

/** What the engine prints for `template` on a page numbered `n` (preview only). */
export function previewStampText(
  template: string,
  v: { n: number; total: number; date: string; filename: string },
): string {
  return resolveEngineTokens(substituteJsTokens(template, v), v.n, v.total);
}

export function describePages(pages: readonly number[], total: number): string {
  if (pages.length === total) return `All ${total} pages`;
  if (pages.length === 1) return `Page ${pages[0]} of ${total}`;
  return `${pages.length} of ${total} pages`;
}

export function describeStyle(style: TextStyle): string {
  return `${style.font.replace("-", " ")} ${style.size} pt`;
}
