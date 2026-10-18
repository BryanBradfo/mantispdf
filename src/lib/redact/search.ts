/**
 * Text search for redaction: pdf.js text content items to match rects in visible page space.
 *
 * Geometry ruling: a match's position along its item is the item width split by character
 * count (pdf.js gives no per-glyph advances), padded by 1 pt on both sides; its height is the
 * font size (from the item transform) from 0.25 em below the baseline to 1 em above. The
 * engine removes every glyph that touches a rect, so slight over-coverage is safe; when the
 * split is too rough (proportional fonts, long items), `wholeItem` marks every item a match
 * touches entirely.
 */
import type { Rect } from "./model";

/** The parts of a pdf.js `TextItem` the search uses. */
export interface TextRun {
  str: string;
  /** Text space to user space: `[a, b, c, d, e, f]`. */
  transform: number[];
  /** Advance of the whole string in user space units. */
  width: number;
  hasEOL: boolean;
}

/** pdf.js `page.view` (the CropBox `[x0, y0, x1, y1]`) and `page.rotate`. */
export interface PageGeometry {
  view: [number, number, number, number];
  rotate: number;
}

export interface SearchOptions {
  wholeWord?: boolean;
  wholeItem?: boolean;
}

export interface Match {
  /** One rect per item the match spans. */
  rects: Rect[];
  /** Their bounding box. */
  rect: Rect;
}

const PAD = 1;
const DESCENT = 0.25;
const ASCENT = 1.0;

/** User space to visible space (the inverse of the engine's `VisibleBox::matrix`). */
export function toVisible({ view, rotate }: PageGeometry, x: number, y: number): [number, number] {
  const [x0, y0, x1, y1] = [Math.min(view[0], view[2]), Math.min(view[1], view[3]), Math.max(view[0], view[2]), Math.max(view[1], view[3])];
  switch (((rotate % 360) + 360) % 360) {
    case 90:
      return [y - y0, x1 - x];
    case 180:
      return [x1 - x, y1 - y];
    case 270:
      return [y1 - y, x - x0];
    default:
      return [x - x0, y - y0];
  }
}

/** Visible-space bounding box of characters `from..to` of `run` (all of it with `whole`). */
function runRect(run: TextRun, from: number, to: number, geometry: PageGeometry): Rect {
  const [a, b, c, d, e, f] = run.transform;
  const along = Math.hypot(a, b) || 1;
  const size = Math.hypot(c, d);
  const [ux, uy] = [a / along, b / along];
  const [vx, vy] = size > 0 ? [c / size, d / size] : [-uy, ux];
  const total = Math.max(1, run.str.length);
  const s0 = (run.width * from) / total - PAD;
  const s1 = (run.width * to) / total + PAD;
  const corners = [
    [s0, -DESCENT * size],
    [s1, -DESCENT * size],
    [s1, ASCENT * size],
    [s0, ASCENT * size],
  ].map(([s, t]) => toVisible(geometry, e + s * ux + t * vx, f + s * uy + t * vy));
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  return [minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY];
}

function union(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r[0]));
  const y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[0] + r[2]));
  const y1 = Math.max(...rects.map((r) => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

const WORD = /[\p{L}\p{N}_]/u;

/** One character (UTF-16 unit) of the joined text, with where it came from. */
interface Slot {
  ch: string;
  /** Item index, or -1 for a line break. */
  item: number;
  /** Position in the item's string. */
  offset: number;
}

/** Lower-case a unit when that keeps it a single unit (so indices stay aligned). */
const fold = (ch: string) => {
  const lower = ch.toLowerCase();
  return lower.length === ch.length ? lower : ch;
};

/** Every case-insensitive match of `query` in the page's text, as visible-space rects. */
export function findMatches(runs: TextRun[], geometry: PageGeometry, query: string, options: SearchOptions = {}): Match[] {
  const needle = Array.from(query, fold).join("");
  if (needle.length === 0) return [];
  const slots: Slot[] = [];
  runs.forEach((run, item) => {
    for (let offset = 0; offset < run.str.length; offset++) slots.push({ ch: fold(run.str[offset]), item, offset });
    if (run.hasEOL) slots.push({ ch: " ", item: -1, offset: 0 });
  });
  const text = slots.map((s) => s.ch).join("");
  const matches: Match[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (options.wholeWord && ((at > 0 && WORD.test(text[at - 1])) || (end < text.length && WORD.test(text[end])))) continue;
    // Group the matched characters by item.
    const spans = new Map<number, [number, number]>();
    for (const slot of slots.slice(at, end)) {
      if (slot.item < 0) continue;
      const span = spans.get(slot.item);
      spans.set(slot.item, span ? [Math.min(span[0], slot.offset), Math.max(span[1], slot.offset + 1)] : [slot.offset, slot.offset + 1]);
    }
    const rects = [...spans].map(([item, [from, to]]) => {
      const run = runs[item];
      return options.wholeItem ? runRect(run, 0, run.str.length, geometry) : runRect(run, from, to, geometry);
    });
    if (rects.length > 0) matches.push({ rects, rect: union(rects) });
  }
  return matches;
}
