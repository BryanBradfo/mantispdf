import { isDrawn, type FormField, type FormWidget } from "./model";

/** Widgets whose tops (rows) or left edges (columns) are this close, in points, line up. */
export const ROW_TOLERANCE = 4;

interface Anchor {
  field: FormField;
  page: number;
  top: number;
  left: number;
  /** Lowest /Annots position of the field's widgets on `page` (null when none is known). */
  annotIndex: number | null;
  tabs: FormWidget["tabs"];
}

/** Where a field sits: its first drawn widget (page, then the highest one). */
function anchor(field: FormField): Anchor | null {
  let best: Anchor | null = null;
  for (const w of field.widgets) {
    if (!isDrawn(w)) continue;
    const a: Anchor = {
      field,
      page: w.page,
      top: Math.max(w.rect[1], w.rect[3]),
      left: Math.min(w.rect[0], w.rect[2]),
      annotIndex: null,
      tabs: w.tabs,
    };
    if (!best || a.page < best.page || (a.page === best.page && (a.top > best.top || (a.top === best.top && a.left < best.left)))) {
      best = a;
    }
  }
  if (best) {
    const page = best.page;
    const indexes = field.widgets.filter((w) => isDrawn(w) && w.page === page && w.annotIndex !== null).map((w) => w.annotIndex as number);
    best.annotIndex = indexes.length > 0 ? Math.min(...indexes) : null;
  }
  return best;
}

/**
 * Groups sorted anchors into lines (rows or columns): an anchor joins the line while its `key`
 * is within `ROW_TOLERANCE` of the line's first anchor; each line is then sorted by `within`.
 */
function lines(sorted: Anchor[], key: (a: Anchor) => number, within: (a: Anchor, b: Anchor) => number): Anchor[] {
  const out: Anchor[] = [];
  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i];
    let j = i + 1;
    while (j < sorted.length && Math.abs(key(first) - key(sorted[j])) <= ROW_TOLERANCE) j++;
    out.push(...sorted.slice(i, j).sort(within));
    i = j;
  }
  return out;
}

const byId = (a: Anchor, b: Anchor) => a.field.id - b.field.id;

/** Rows top to bottom, each left to right. */
function rowOrder(anchors: Anchor[]): Anchor[] {
  const sorted = [...anchors].sort((a, b) => b.top - a.top || a.left - b.left || byId(a, b));
  return lines(sorted, (a) => a.top, (a, b) => a.left - b.left || byId(a, b));
}

/** Columns left to right, each top to bottom. */
function columnOrder(anchors: Anchor[]): Anchor[] {
  const sorted = [...anchors].sort((a, b) => a.left - b.left || b.top - a.top || byId(a, b));
  return lines(sorted, (a) => a.left, (a, b) => b.top - a.top || byId(a, b));
}

/** The page's annotation order; anchors without a known position follow, in rows. */
function structureOrder(anchors: Anchor[]): Anchor[] {
  const known = anchors.filter((a) => a.annotIndex !== null).sort((a, b) => (a.annotIndex as number) - (b.annotIndex as number) || byId(a, b));
  return [...known, ...rowOrder(anchors.filter((a) => a.annotIndex === null))];
}

/**
 * Fields in tab order: page by page, each page by its /Tabs (R rows, C columns, S the page's
 * annotation order, which stands in for the structure order), rows when the page has no /Tabs.
 * Rows run top to bottom (tops within `ROW_TOLERANCE` points of the row's first field), then left
 * to right; columns likewise. Fields with no drawn widget come last, in id order.
 */
export function tabOrder(fields: readonly FormField[]): FormField[] {
  const pages = new Map<number, Anchor[]>();
  const unplaced: FormField[] = [];
  for (const f of fields) {
    const a = anchor(f);
    if (!a) {
      unplaced.push(f);
      continue;
    }
    const list = pages.get(a.page);
    if (list) list.push(a);
    else pages.set(a.page, [a]);
  }
  const out: FormField[] = [];
  for (const page of [...pages.keys()].sort((a, b) => a - b)) {
    const anchors = pages.get(page) as Anchor[];
    // Every widget of a page carries the same /Tabs.
    const tabs = anchors[0].tabs;
    const ordered = tabs === "C" ? columnOrder(anchors) : tabs === "S" ? structureOrder(anchors) : rowOrder(anchors);
    out.push(...ordered.map((a) => a.field));
  }
  return [...out, ...unplaced.sort((a, b) => a.id - b.id)];
}
