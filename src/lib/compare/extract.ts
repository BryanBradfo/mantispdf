import { toVisible, type PageGeometry, type TextRun } from "../redact/search";
import type { Word } from "./types";

/** The parts of a pdf.js page the extraction uses. */
export interface PdfLike {
  numPages: number;
  getPage(n: number): Promise<{ view: number[]; rotate: number; getTextContent(): Promise<{ items: ReadonlyArray<object> }> }>;
}

const DESCENT = 0.25;
/** Runs of non-space characters (`\s` already covers NBSP, thin and ideographic spaces). */
const WORD = /\S+/gu;

const SAME_BASELINE = 0.2; // em
const MERGE_GAP = 0.15; // em: closer than this means no word break
const MAX_OVERLAP = 0.5; // em

/**
 * Glue runs that continue each other (a word split by the producer): same direction and size,
 * same baseline (< 0.2 em), and a gap along the text under 0.15 em. A gap of 0.15 em or more
 * (word spacing without a space character) or a line end starts a new segment.
 */
function mergeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  let cur: TextRun | null = null as TextRun | null;
  let eol = false;
  for (const run of runs) {
    if (!run.str) {
      if (run.hasEOL) eol = true;
      continue;
    }
    if (cur && !eol && canMerge(cur, run)) {
      const prev: TextRun = cur;
      const [pa, pb, , , pe, pf] = prev.transform;
      const start: number = ((run.transform[4] - pe) * pa + (run.transform[5] - pf) * pb) / (Math.hypot(pa, pb) || 1);
      cur = { str: prev.str + run.str, transform: prev.transform, width: start + run.width, hasEOL: run.hasEOL };
      out[out.length - 1] = cur;
    } else {
      cur = { ...run };
      out.push(cur);
    }
    eol = run.hasEOL;
  }
  return out;
}

function canMerge(x: TextRun, y: TextRun): boolean {
  const [a, b, c, d, e, f] = x.transform;
  const [a2, b2, c2, d2, e2, f2] = y.transform;
  const along = Math.hypot(a, b);
  const along2 = Math.hypot(a2, b2);
  const size = Math.hypot(c, d);
  if (!along || !along2 || !size) return false;
  const [ux, uy] = [a / along, b / along];
  if (ux * (a2 / along2) + uy * (b2 / along2) < 0.999) return false; // same direction
  if (Math.abs(Math.hypot(c2, d2) - size) > 0.2 * size) return false;
  const [dx, dy] = [e2 - e, f2 - f];
  if (Math.abs(-dx * uy + dy * ux) >= SAME_BASELINE * size) return false;
  const gap = dx * ux + dy * uy - x.width;
  return gap < MERGE_GAP * size && gap > -MAX_OVERLAP * size;
}

/**
 * Split text runs into words with boxes. A run carries no per-glyph advances, so each word gets
 * its share of the run width by character count. Boxes are in the visible page space (rotation
 * applied, origin bottom-left, CropBox origin removed), from 0.25 em below the baseline to 1 em above.
 */
export function wordsFromRuns(runs: TextRun[], geometry: PageGeometry, page: number): Word[] {
  const words: Word[] = [];
  for (const run of mergeRuns(runs)) {
    const [a, b, c, d, e, f] = run.transform;
    const along = Math.hypot(a, b) || 1;
    const size = Math.hypot(c, d);
    const [ux, uy] = [a / along, b / along];
    const [vx, vy] = size > 0 ? [c / size, d / size] : [-uy, ux];
    for (const m of run.str.matchAll(WORD)) {
      const s0 = (run.width * m.index) / run.str.length;
      const s1 = (run.width * (m.index + m[0].length)) / run.str.length;
      const corners = [
        [s0, -DESCENT * size],
        [s1, -DESCENT * size],
        [s1, size],
        [s0, size],
      ].map(([s, t]) => toVisible(geometry, e + s * ux + t * vx, f + s * uy + t * vy));
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      words.push({ text: m[0], page, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } });
    }
  }
  return words;
}

/**
 * Words of every page, page i at index i (an empty array for a page without text). `onProgress`
 * gets page i of N after each page; `signal` stops it between pages (rejects with an AbortError).
 */
export async function extractWords(
  doc: PdfLike,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Word[][]> {
  const pages: Word[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (signal?.aborted) {
      const e = new Error("Extraction cancelled");
      e.name = "AbortError";
      throw e;
    }
    const p = await doc.getPage(n);
    const content = await p.getTextContent();
    const runs: TextRun[] = [];
    for (const item of content.items) {
      if ("str" in item) {
        const t = item as { str: string; transform: number[]; width: number; hasEOL: boolean };
        runs.push({ str: t.str, transform: t.transform, width: t.width, hasEOL: t.hasEOL });
      }
    }
    pages.push(wordsFromRuns(runs, { view: p.view as [number, number, number, number], rotate: p.rotate }, n - 1));
    onProgress?.(n, doc.numPages);
  }
  return pages;
}
