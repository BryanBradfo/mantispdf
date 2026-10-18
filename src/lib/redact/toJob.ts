/**
 * Marks to the engine's wire shapes (`crates/mantis-wasm/src/redact/binding.rs`, keys in
 * `wireKeys.ts`): areas `{ page, rect }` in visible space, the job with fill colour, metadata
 * choice and the rasters of the pages the plan reported as unsupported.
 */
import type { Mark, Rect } from "./model";

export type Fill = "black" | "white";

export interface RedactRectWire {
  /** 1-based page. */
  page: number;
  rect: Rect;
}

/** A page rendered at `dpi`: `width` x `height` RGBA pixels of its visible box. */
export interface RasterWire {
  page: number;
  width: number;
  height: number;
  dpi: number;
  rgba: Uint8Array;
}

export interface RedactJobWire {
  rects: RedactRectWire[];
  fill: Fill;
  removeMetadata: boolean;
  rasters: RasterWire[];
}

/** What `redact_plan` returns per page with marks: `reason` is null when no raster is needed. */
export interface PageStatusWire {
  page: number;
  reason: string | null;
}

/** What `redact` returns. */
export interface RedactResultWire {
  bytes: Uint8Array;
  pagesRedacted: number[];
  pagesRasterized: number[];
  glyphsRemoved: number;
  pathsRemoved: number;
  imagesRedacted: number;
  formsRedacted: number;
  annotationsRemoved: number;
  /**
   * Pages where the engine widened a box so it covers all the text it removed. Optional: absent
   * from engines that do not report it.
   */
  widenedPages?: number[];
}

const normalized = ([x, y, w, h]: Rect): Rect => [Math.min(x, x + w), Math.min(y, y + h), Math.abs(w), Math.abs(h)];

/**
 * The engine areas of `marks`, by page: a page mark covers the page's visible `[width, height]`
 * from `pageSizes` (index = page - 1); marks on pages without a size are skipped.
 */
export function marksToRects(marks: readonly Mark[], pageSizes: [number, number][]): RedactRectWire[] {
  const out: RedactRectWire[] = [];
  for (const m of marks) {
    const size = pageSizes[m.page - 1];
    if (!size) continue;
    out.push({ page: m.page, rect: m.kind === "page" ? [0, 0, size[0], size[1]] : normalized(m.rect) });
  }
  return out.sort((a, b) => a.page - b.page);
}

export function toJob(
  marks: readonly Mark[],
  pageSizes: [number, number][],
  options: { fill: Fill; removeMetadata: boolean },
  rasters: RasterWire[],
): RedactJobWire {
  return { rects: marksToRects(marks, pageSizes), fill: options.fill, removeMetadata: options.removeMetadata, rasters };
}

/** `redact_search` options. */
export interface SearchOptionsWire {
  wholeWord: boolean;
  caseSensitive: boolean;
}

/** What `redact_search` returns: per page, one visible rect `[x, y, w, h]` per line of each match. */
export interface RedactSearchWire {
  pages: { page: number; quads: Rect[] }[];
  /** Pages with text the engine cannot read: search may miss text there (see `search.ts`). */
  undecodablePages: number[];
  /**
   * The engine stopped at its match limit (10000 rects): the UI says "Too many matches; showing
   * the first N. Refine the search." `unsearchedPages` were not (fully) searched.
   */
  truncated: boolean;
  unsearchedPages: number[];
}

/**
 * What one redaction runs with, taken when the user starts it: the plan, the rasters, the job
 * and the report all use this, never the marks as they are later.
 */
export interface RedactRun {
  marks: readonly Mark[];
  fill: Fill;
  removeMetadata: boolean;
}

export const takeRun = (marks: readonly Mark[], fill: Fill, removeMetadata: boolean): RedactRun => ({ marks, fill, removeMetadata });

/** The same marks (by id and geometry, in order) and options. */
export function sameRun(a: RedactRun, b: RedactRun): boolean {
  if (a.fill !== b.fill || a.removeMetadata !== b.removeMetadata || a.marks.length !== b.marks.length) return false;
  return a.marks.every((m, i) => {
    const n = b.marks[i];
    if (m === n) return true;
    if (m.id !== n.id || m.kind !== n.kind || m.page !== n.page) return false;
    return m.kind === "page" || (n.kind !== "page" && m.rect.every((v, k) => v === n.rect[k]));
  });
}
