/** Helpers for making marks: reviewing search results, repeating an area on other pages. */
import type { MarkInput, Rect } from "./model";
import type { SearchContextWire, SearchMatchWire } from "./searchWire";

/** One match of a search, for the results review: one checkbox, a mark per line it spans. */
export interface SearchEntry {
  /** Position in the list (checkbox key). */
  id: number;
  page: number;
  marks: MarkInput[];
  /** The text around the match (engine matches); null for a fallback match on unreadable text. */
  context: SearchContextWire | null;
}

/**
 * The review list: the engine's matches (with context), then the fallback matches found by pdf.js
 * in text the engine cannot read (already limited to its unknown boxes, see `fallbackRects`).
 */
export function searchEntries(
  matches: readonly SearchMatchWire[],
  fallback: readonly { page: number; rects: Rect[] }[],
  query: string,
): SearchEntry[] {
  const toMarks = (page: number, rects: Rect[]): MarkInput[] => rects.map((rect) => ({ kind: "search", page, rect, query }));
  const entries: SearchEntry[] = matches.map((m, id) => ({ id, page: m.page, marks: toMarks(m.page, m.rects), context: m.context }));
  for (const f of fallback) {
    entries.push({ id: entries.length, page: f.page, marks: toMarks(f.page, f.rects), context: null });
  }
  return entries;
}

/** How an entry reads: "Page N: …before[text]after…" (text shown bold by the list). */
export function entryText(e: SearchEntry): { page: number; before: string; text: string; after: string } {
  if (!e.context) return { page: e.page, before: "", text: "unreadable text", after: "" };
  const { before, text, after } = e.context;
  return { page: e.page, before: before ? `…${before}` : "", text, after: after ? `${after}…` : "" };
}

/** The marks of the checked entries, every line of each, in list order. */
export function selectedMarks(entries: readonly SearchEntry[], checked: ReadonlySet<number>): MarkInput[] {
  return entries.filter((e) => checked.has(e.id)).flatMap((e) => e.marks);
}

/** Whether two rects share a positive area. */
const meets = (a: Rect, b: Rect) =>
  Math.min(a[0] + a[2], b[0] + b[2]) > Math.max(a[0], b[0]) && Math.min(a[1] + a[3], b[1] + b[3]) > Math.max(a[1], b[1]);

/**
 * Of the whole-item rects pdf.js found on a page the engine could not fully read, the ones that
 * meet its unknown-text boxes: text the engine decoded already has exact match rects.
 */
export function fallbackRects(rects: readonly Rect[], unknown: readonly Rect[]): Rect[] {
  return rects.filter((r) => unknown.some((u) => meets(r, u)));
}

/**
 * Copies of the area `rect` (on `from`) for `pages`: every page other than `from` large enough to
 * hold it at the same place (visible sizes in `pageSizes`, index = page - 1); the rest are
 * `skipped`.
 */
export function repeatTargets(
  rect: Rect,
  from: number,
  pages: readonly number[],
  pageSizes: readonly [number, number][],
): { marks: MarkInput[]; skipped: number[] } {
  const [x, y, w, h] = rect;
  const marks: MarkInput[] = [];
  const skipped: number[] = [];
  for (const page of pages) {
    if (page === from) continue;
    const size = pageSizes[page - 1];
    if (size && x >= 0 && y >= 0 && x + w <= size[0] && y + h <= size[1]) marks.push({ kind: "area", page, rect: [x, y, w, h] });
    else skipped.push(page);
  }
  return { marks, skipped };
}
