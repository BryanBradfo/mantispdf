/** Pure helpers of the overlay view (page list, filter, render size, percentages). */

/** Largest render width in device pixels (memory: 2000 x 2600 RGBA is about 20 MB per image). */
export const MAX_RENDER_PX = 2000;
/** Render widths are rounded up to this step so a small resize keeps the renders. */
const WIDTH_STEP = 100;

export type EntryKind = "pair" | "only-a" | "only-b";
export interface OverlayEntry {
  /** 1-based page number (the same in both documents for a pair). */
  page: number;
  kind: EntryKind;
}

export type PageResult = { status: "done"; ratio: number } | { status: "error" };

/** Page i of the original against page i of the modified copy; the longer document's extra pages alone. */
export function overlayEntries(pagesA: number, pagesB: number): OverlayEntry[] {
  const out: OverlayEntry[] = [];
  for (let i = 1; i <= Math.max(pagesA, pagesB); i++) {
    out.push({ page: i, kind: i > pagesA ? "only-b" : i > pagesB ? "only-a" : "pair" });
  }
  return out;
}

/** Does this page differ? `null` while not computed yet. Pages in one document only always do. */
export function entryDiffers(entry: OverlayEntry, results: ReadonlyMap<number, PageResult>): boolean | null {
  if (entry.kind !== "pair") return true;
  const r = results.get(entry.page);
  if (!r) return null;
  // A page that could not be rendered is kept: it may differ.
  return r.status === "error" || r.ratio > 0;
}

/** The pages the selector shows: all, or (filter on) only those known to differ. */
export function visibleEntries(entries: readonly OverlayEntry[], results: ReadonlyMap<number, PageResult>, onlyDifferent: boolean): OverlayEntry[] {
  return onlyDifferent ? entries.filter((e) => entryDiffers(e, results) === true) : [...entries];
}

/** Device-pixel width to render a page shown `cssWidth` px wide: x devicePixelRatio, stepped, capped. */
export function overlayRenderWidth(cssWidth: number, dpr: number): number {
  const want = Math.max(1, cssWidth * (dpr || 1));
  return Math.min(MAX_RENDER_PX, Math.ceil(want / WIDTH_STEP) * WIDTH_STEP);
}

/**
 * The share to print (to one decimal place of a percent): a real change never shows as 0 % (it
 * shows "< 0.1 %", `below`) nor as 100 % unless every pixel changed.
 */
export function percentParts(ratio: number): { value: number; below: boolean } {
  if (ratio <= 0) return { value: 0, below: false };
  if (ratio < 0.001) return { value: 0.001, below: true };
  if (ratio >= 1) return { value: 1, below: false };
  return { value: Math.min(0.999, Math.round(ratio * 1000) / 1000), below: false };
}
