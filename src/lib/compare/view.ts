import type { CompareResult, Word } from "./types";

/** A visible page size in points (CropBox, /Rotate applied), as the engine's `pageSizes` gives it. */
export type Size = readonly [number, number];
export type Box = Word["box"];
export type Side = "a" | "b";

/** One highlight over a page render: removed words on the original, added words on the modified copy. */
export interface Mark {
  /** Index in `result.changes`. */
  change: number;
  kind: "removed" | "added";
  box: Box;
}

/**
 * Where a document position lands. Positions are `page + fraction`, the fraction measured from the
 * top of the page (0) to its bottom (1): page 2 halfway down is 1.5.
 */
export type Position = number;

export function countWords(pages: Word[][]): number {
  return pages.reduce((n, p) => n + p.length, 0);
}

function flatten(pages: Word[][]): Word[] {
  return pages.flat();
}

/** Words on one line (vertical overlap of half the smaller height) with a gap under 1 em join into one box. */
export function mergeLineBoxes(words: Word[]): Box[] {
  const out: Box[] = [];
  let cur: Box | null = null;
  for (const { box } of words) {
    if (cur) {
      const overlap = Math.min(cur.y + cur.h, box.y + box.h) - Math.max(cur.y, box.y);
      const em = Math.max(cur.h, box.h);
      const gap = box.x - (cur.x + cur.w);
      if (overlap >= 0.5 * Math.min(cur.h, box.h) && gap <= em && gap >= -em) {
        const x = Math.min(cur.x, box.x);
        const y = Math.min(cur.y, box.y);
        cur = { x, y, w: Math.max(cur.x + cur.w, box.x + box.w) - x, h: Math.max(cur.y + cur.h, box.y + box.h) - y };
        out[out.length - 1] = cur;
        continue;
      }
    }
    cur = { ...box };
    out.push(cur);
  }
  return out;
}

/**
 * The part of a word box a mark covers. Extraction boxes run from 0.25 em below the baseline to
 * 1 em above it (1.25 em, so lines set solid touch); a mark keeps 0.15 em below to 0.85 em above,
 * which leaves a gap to the lines above and below. Assumes horizontal text in the visible page
 * (pages turned by /Rotate are already upright there).
 */
export function markBox(box: Box): Box {
  const em = box.h / 1.25;
  return { x: box.x, y: box.y + 0.1 * em, w: box.w, h: em };
}

/** The distinct source words of a token range, in order (a word split into several tokens counts once). */
function wordsOf(index: number[], start: number, end: number, flat: Word[]): Word[] {
  const out: Word[] = [];
  let last = -1;
  for (let i = start; i < end; i++) {
    const w = index[i];
    if (w === last) continue;
    last = w;
    out.push(flat[w]);
  }
  return out;
}

function marksForSide(result: CompareResult, side: Side, pages: Word[][]): Mark[][] {
  const flat = flatten(pages);
  const index = side === "a" ? result.aIndex : result.bIndex;
  const out: Mark[][] = pages.map(() => []);
  const kind = side === "a" ? "removed" : "added";
  result.changes.forEach((c, change) => {
    const range = side === "a" ? c.a : c.b;
    if (range.end <= range.start) return;
    const byPage = new Map<number, Word[]>();
    for (const w of wordsOf(index, range.start, range.end, flat)) {
      const list = byPage.get(w.page);
      if (list) list.push(w);
      else byPage.set(w.page, [w]);
    }
    for (const [page, words] of byPage) {
      for (const box of mergeLineBoxes(words.map((w) => ({ ...w, box: markBox(w.box) })))) out[page]?.push({ change, kind, box });
    }
  });
  return out;
}

/** Highlights per page for both sides (`a[i]` = marks on page i of the original). */
export function highlightMarks(result: CompareResult, a: Word[][], b: Word[][]): { a: Mark[][]; b: Mark[][] } {
  return { a: marksForSide(result, "a", a), b: marksForSide(result, "b", b) };
}

function wordPos(w: Word, sizes: readonly Size[], at: "top" | "center"): Position {
  const h = sizes[w.page]?.[1] ?? 0;
  if (!(h > 0)) return w.page;
  const y = at === "top" ? w.box.y + w.box.h : w.box.y + w.box.h / 2;
  return w.page + Math.min(1, Math.max(0, (h - y) / h));
}

/**
 * Pairs of positions `[original, modified]` that show the same text, for synchronised scrolling:
 * the first and last word of every matched stretch, from `[0, 0]` to `[pagesA, pagesB]`. Kept
 * strictly increasing on both sides (multi-column pages or moved text cannot fold the mapping back).
 */
export function buildAnchors(result: CompareResult, a: Word[][], b: Word[][], aSizes: readonly Size[], bSizes: readonly Size[]): [Position, Position][] {
  const fa = flatten(a);
  const fb = flatten(b);
  const anchors: [Position, Position][] = [[0, 0]];
  const push = (ta: number, tb: number) => {
    const pa = wordPos(fa[result.aIndex[ta]], aSizes, "center");
    const pb = wordPos(fb[result.bIndex[tb]], bSizes, "center");
    const [la, lb] = anchors[anchors.length - 1];
    if (pa > la && pb > lb) anchors.push([pa, pb]);
  };
  const stretch = (a0: number, a1: number, b0: number) => {
    if (a1 <= a0) return;
    push(a0, b0);
    if (a1 - 1 > a0) push(a1 - 1, b0 + (a1 - 1 - a0));
  };
  let pa = 0;
  let pb = 0;
  for (const c of result.changes) {
    stretch(pa, Math.min(c.a.start, pa + (c.b.start - pb)), pb);
    pa = c.a.end;
    pb = c.b.end;
  }
  stretch(pa, Math.min(result.aIndex.length, pa + (result.bIndex.length - pb)), pb);
  const end: [Position, Position] = [aSizes.length, bSizes.length];
  const [la, lb] = anchors[anchors.length - 1];
  if (end[0] > la && end[1] > lb) anchors.push(end);
  return anchors;
}

/** Map a position through the anchors (piecewise linear, clamped to the ends). */
export function mapPosition(anchors: readonly [Position, Position][], pos: Position, direction: "a-to-b" | "b-to-a" = "a-to-b"): Position {
  if (anchors.length === 0) return pos;
  const [from, to] = direction === "a-to-b" ? [0, 1] : [1, 0];
  if (pos <= anchors[0][from]) return anchors[0][to];
  for (let i = 1; i < anchors.length; i++) {
    const p = anchors[i - 1];
    const q = anchors[i];
    if (pos <= q[from]) {
      const span = q[from] - p[from];
      const t = span > 0 ? (pos - p[from]) / span : 0;
      return p[to] + t * (q[to] - p[to]);
    }
  }
  return anchors[anchors.length - 1][to];
}

/** The position of a pixel offset in a column of pages (`tops`/`heights` in the same pixels). */
export function posFromPx(tops: readonly number[], heights: readonly number[], px: number): Position {
  let i = -1;
  for (let k = 0; k < tops.length && tops[k] <= px; k++) i = k;
  if (i < 0) return 0;
  const h = heights[i];
  const frac = h > 0 ? Math.min(1, Math.max(0, (px - tops[i]) / h)) : 0;
  return i + frac;
}

/** Inverse of `posFromPx`. */
export function pxFromPos(tops: readonly number[], heights: readonly number[], pos: Position): number {
  if (tops.length === 0) return 0;
  const i = Math.max(0, Math.min(Math.floor(pos), tops.length - 1));
  const frac = Math.min(1, Math.max(0, pos - i));
  return tops[i] + frac * heights[i];
}

/**
 * Where a change sits on one side: the top of its first word there, or, when that side has none
 * (text only added or only removed), the top of the word just before the change (else just after).
 */
export function changeTarget(result: CompareResult, change: number, side: Side, pages: Word[][], sizes: readonly Size[]): Position {
  const c = result.changes[change];
  const range = side === "a" ? c.a : c.b;
  const index = side === "a" ? result.aIndex : result.bIndex;
  const flat = flatten(pages);
  let token = range.start;
  if (range.end <= range.start) token = range.start > 0 ? range.start - 1 : range.start;
  const w = flat[index[token]];
  return w ? wordPos(w, sizes, "top") : 0;
}
