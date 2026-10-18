import { isDrawn, type FormField } from "./model";

/** Widgets whose tops are this close (points) read as one row. */
export const ROW_TOLERANCE = 4;

interface Anchor {
  field: FormField;
  page: number;
  top: number;
  left: number;
}

/** Where a field sits: its first drawn widget (page, then the highest one). */
function anchor(field: FormField): Anchor | null {
  let best: Anchor | null = null;
  for (const w of field.widgets) {
    if (!isDrawn(w)) continue;
    const a = { field, page: w.page, top: Math.max(w.rect[1], w.rect[3]), left: Math.min(w.rect[0], w.rect[2]) };
    if (!best || a.page < best.page || (a.page === best.page && (a.top > best.top || (a.top === best.top && a.left < best.left)))) {
      best = a;
    }
  }
  return best;
}

/**
 * Fields in reading order: by page, then top to bottom in rows (tops within
 * `ROW_TOLERANCE` points of the row's first field), then left to right.
 * Fields with no drawn widget come last, in id order. (/Tabs is not exposed
 * by the engine; visual order is used on every page.)
 */
export function tabOrder(fields: readonly FormField[]): FormField[] {
  const placed: Anchor[] = [];
  const unplaced: FormField[] = [];
  for (const f of fields) {
    const a = anchor(f);
    if (a) placed.push(a);
    else unplaced.push(f);
  }
  placed.sort((a, b) => a.page - b.page || b.top - a.top || a.left - b.left || a.field.id - b.field.id);

  const out: FormField[] = [];
  let i = 0;
  while (i < placed.length) {
    const first = placed[i];
    let j = i + 1;
    while (j < placed.length && placed[j].page === first.page && first.top - placed[j].top <= ROW_TOLERANCE) j++;
    const row = placed.slice(i, j).sort((a, b) => a.left - b.left || a.field.id - b.field.id);
    out.push(...row.map((a) => a.field));
    i = j;
  }
  return [...out, ...unplaced.sort((a, b) => a.id - b.id)];
}
