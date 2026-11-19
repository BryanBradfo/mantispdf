import { toVisible, type PageGeometry, type TextRun } from "../redact/search";
import type { Word } from "./types";

/** The parts of a pdf.js page the extraction uses. */
export interface PdfLike {
  numPages: number;
  getPage(n: number): Promise<{ view: number[]; rotate: number; getTextContent(): Promise<{ items: ReadonlyArray<object> }> }>;
}

const DESCENT = 0.25;
const WHITESPACE = /[^\s   -   　]+/gu;

/**
 * Split text runs into words with boxes. A run carries no per-glyph advances, so each word gets
 * its share of the run width by character count. Boxes are in the visible page space (rotation
 * applied, origin bottom-left, CropBox origin removed), from 0.25 em below the baseline to 1 em above.
 */
export function wordsFromRuns(runs: TextRun[], geometry: PageGeometry, page: number): Word[] {
  const words: Word[] = [];
  for (const run of runs) {
    if (!run.str) continue;
    const [a, b, c, d, e, f] = run.transform;
    const along = Math.hypot(a, b) || 1;
    const size = Math.hypot(c, d);
    const [ux, uy] = [a / along, b / along];
    const [vx, vy] = size > 0 ? [c / size, d / size] : [-uy, ux];
    for (const m of run.str.matchAll(WHITESPACE)) {
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

/** Words of every page, page i at index i (an empty array for a page without text). */
export async function extractWords(doc: PdfLike, onProgress?: (done: number, total: number) => void): Promise<Word[][]> {
  const pages: Word[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
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
