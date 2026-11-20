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

/** Pixel budget of the compute grid per page (about 1.5 MP: 1077 x 1393 for Letter). */
export const GRID_PIXELS = 1_500_000;
/** Longest side of a page on the grid (bounds posters and strips). */
export const GRID_MAX_SIDE = 4000;
const LETTER: readonly [number, number] = [612, 792];

export interface PairGrid {
  /** Render scales (device pixels per PDF unit) of the original and the modified page. */
  scaleA: number;
  scaleB: number;
  /** Render widths in device pixels. */
  widthA: number;
  widthB: number;
}

/**
 * The fixed grid a page pair is diffed on: the original at the scale that fills GRID_PIXELS, the
 * modified page fitted to the same width (spec 1.4), each bounded to GRID_MAX_SIDE. It depends on
 * the page sizes only (visible orientation), never on the screen, so the percentage, the mask and
 * "differs" are the same on every device.
 */
export function pairGrid(sizeA: readonly [number, number], sizeB: readonly [number, number]): PairGrid {
  const ok = (s: readonly [number, number]) => (s[0] > 0 && s[1] > 0 ? s : LETTER);
  const [wA, hA] = ok(sizeA);
  const [wB, hB] = ok(sizeB);
  const scaleA = Math.min(Math.sqrt(GRID_PIXELS / (wA * hA)), GRID_MAX_SIDE / wA, GRID_MAX_SIDE / hA);
  const widthA = Math.max(1, Math.round(wA * scaleA));
  const scaleB = Math.min(widthA / wB, GRID_MAX_SIDE / hB);
  const widthB = Math.max(1, Math.round(wB * scaleB));
  return { scaleA, scaleB, widthA, widthB };
}
