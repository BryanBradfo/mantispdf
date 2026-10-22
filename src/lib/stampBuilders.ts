import { resolveEngineTokens, substituteJsTokens, type Anchor, type StampJobSpec, type StdFont, type TextStampSpec } from "./stampJob";
import type { NsT } from "../i18n";

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

/**
 * Page-number formats. The templates are printed on the page, so they follow the UI language;
 * their tokens are passed back as themselves (`{ n: "{n}" }`) and resolved by the engine.
 */
export function pageNumberPresets(t: NsT<"stamp">): { id: string; label: string; template: string }[] {
  return [
    { id: "n", label: "1", template: "{n}" },
    { id: "page-n", label: t("templatePage", { n: 1 }), template: t("templatePage", { n: "{n}" }) },
    { id: "n-total", label: "1 / 12", template: "{n} / {total}" },
    {
      id: "page-n-of",
      label: t("templatePageOf", { n: 1, total: 12 }),
      template: t("templatePageOf", { n: "{n}", total: "{total}" }),
    },
  ];
}

export function anchorLabel(anchor: Anchor, t: NsT<"stamp">): string {
  return t(`anchor.${anchor}`);
}

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
  { anchor: "top-left" },
  { anchor: "top-center" },
  { anchor: "top-right" },
  { anchor: "bottom-left" },
  { anchor: "bottom-center" },
  { anchor: "bottom-right" },
] as const satisfies readonly { anchor: Anchor }[];

export type HeaderFooterAnchor = (typeof HEADER_FOOTER_SLOTS)[number]["anchor"];
export type HeaderFooterSlots = Record<HeaderFooterAnchor, string>;

/** "Header left", "Footer center", ... */
export function slotLabel(anchor: HeaderFooterAnchor, t: NsT<"stamp">): string {
  return t(`slot.${anchor}`);
}

export interface HeaderFooterSettings {
  slots: HeaderFooterSlots;
  style: TextStyle;
  margin: number;
  /** {n} printed on the first selected page. */
  numberStart: number;
}

/** Returns null when every slot is blank (nothing to stamp). */
export function buildHeaderFooterJob(s: HeaderFooterSettings, ctx: JobContext): StampJobSpec | null {
  const texts = HEADER_FOOTER_SLOTS.filter((slot) => s.slots[slot.anchor].trim() !== "").map((slot) =>
    textSpec(substituteJsTokens(s.slots[slot.anchor], ctx), slot.anchor, s.style, s.margin),
  );
  if (texts.length === 0) return null;
  return { pages: pagesSpec(ctx.pages, ctx.total), texts, images: [], numberStart: s.numberStart };
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

/** The filled header and footer texts as printed on the first selected page (preview only). */
export function previewHeaderFooter(
  slots: HeaderFooterSlots,
  numberStart: number,
  ctx: JobContext,
  t: NsT<"stamp">,
): { label: string; text: string }[] {
  const range = pageNumberRange(numberStart, ctx.pages);
  return HEADER_FOOTER_SLOTS.filter((slot) => slots[slot.anchor].trim() !== "").map((slot) => ({
    label: slotLabel(slot.anchor, t),
    text: previewStampText(slots[slot.anchor], { n: range.first, total: range.last, date: ctx.date, filename: ctx.filename }),
  }));
}

export function describePages(pages: readonly number[], total: number, t: NsT<"pages">): string {
  if (pages.length === total) return t("pagesAll", { count: total });
  if (pages.length === 1) return t("pagesOne", { page: pages[0], total });
  return t("pagesSome", { count: pages.length, total });
}

export function describeStyle(style: TextStyle, t: NsT<"stamp">): string {
  return t("styleSummary", { font: style.font.replace("-", " "), size: style.size });
}
