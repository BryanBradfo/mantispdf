/** Helpers for making marks: reviewing search results, repeating an area on other pages. */
import type { MarkInput, Rect } from "./model";

/** One area a search found, numbered on its page, for the results review. */
export interface SearchEntry {
  /** Position in the search's list (checkbox key). */
  id: number;
  page: number;
  /** 1-based number of this area on its page. */
  index: number;
  mark: MarkInput;
}

/** The found areas (one per line of each match) numbered per page, in the given order. */
export function numberEntries(found: readonly MarkInput[]): SearchEntry[] {
  const perPage = new Map<number, number>();
  return found.map((mark, id) => {
    const index = (perPage.get(mark.page) ?? 0) + 1;
    perPage.set(mark.page, index);
    return { id, page: mark.page, index, mark };
  });
}

export const entryLabel = (e: SearchEntry): string => `Page ${e.page}, match ${e.index}`;

/** The marks of the checked entries, in list order. */
export function selectedMarks(entries: readonly SearchEntry[], checked: ReadonlySet<number>): MarkInput[] {
  return entries.filter((e) => checked.has(e.id)).map((e) => e.mark);
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
