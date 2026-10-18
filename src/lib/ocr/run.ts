/** The OCR page's pure parts: recognised words to the engine's wire, the summary, progress. */
import type { RecognizedWord } from "./engine";
import type { OcrLanguage } from "./languages";
import type { OcrWordWire } from "./textLayerWire";

/** Pages whose mean word confidence is below this are flagged as low quality scans. */
export const LOW_QUALITY = 60;
/** The engine's limits on a word (`add_text_layer`). */
const MAX_WORD_UNITS = 200;
const MIN_BOX_PT = 0.01;

/**
 * Words recognised on an image of `imagePx` pixels (y down) to visible-space points (y up) on a
 * page of `pagePt` points. A space follows every word but the last of its line. Words the engine
 * would refuse (box under 0.01 pt, text over 200 UTF-16 units) are dropped.
 */
export function wordsToWire(words: readonly RecognizedWord[], imagePx: [number, number], pagePt: [number, number]): OcrWordWire[] {
  const sx = pagePt[0] / imagePx[0];
  const sy = pagePt[1] / imagePx[1];
  const out: OcrWordWire[] = [];
  for (const word of words) {
    const { x0, y0, x1, y1 } = word.bbox;
    const w = (x1 - x0) * sx;
    const h = (y1 - y0) * sy;
    if (!(w >= MIN_BOX_PT && h >= MIN_BOX_PT) || word.text.length > MAX_WORD_UNITS) continue;
    out.push({
      text: word.text,
      x: x0 * sx,
      y: pagePt[1] - y1 * sy,
      w,
      h,
      baseline: word.baseline === null ? null : pagePt[1] - word.baseline * sy,
      spaceAfter: !word.lineEnd,
    });
  }
  return out;
}

export type PageOutcome = { page: number; skipped: true } | { page: number; skipped: false; confidence: number; words: number };

export interface OcrSummary {
  /** Pages recognised. */
  processed: number;
  /** Pages skipped because they already had text. */
  skipped: number[];
  /** Mean of the recognised pages' confidences (pages with words only); null when none. */
  averageConfidence: number | null;
  /** Recognised pages below `LOW_QUALITY`. */
  lowQuality: number[];
  /** Recognised pages where no text was found. */
  noText: number[];
  words: number;
}

export function summarize(outcomes: readonly PageOutcome[]): OcrSummary {
  const done = outcomes.filter((o): o is Extract<PageOutcome, { skipped: false }> => !o.skipped);
  const withWords = done.filter((o) => o.words > 0);
  return {
    processed: done.length,
    skipped: outcomes.filter((o) => o.skipped).map((o) => o.page),
    averageConfidence: withWords.length > 0 ? withWords.reduce((s, o) => s + o.confidence, 0) / withWords.length : null,
    lowQuality: withWords.filter((o) => o.confidence < LOW_QUALITY).map((o) => o.page),
    noText: done.filter((o) => o.words === 0).map((o) => o.page),
    words: done.reduce((s, o) => s + o.words, 0),
  };
}

/** Time left from the pace so far (null before the first page is done). */
export function estimateRemainingMs({ done, total, elapsedMs }: { done: number; total: number; elapsedMs: number }): number | null {
  if (done <= 0) return null;
  return Math.max(0, Math.round((elapsedMs / done) * (total - done)));
}

export function formatEta(ms: number | null): string {
  if (ms === null) return "estimating time left";
  const s = Math.round(ms / 1000);
  if (s <= 0) return "almost done";
  if (s < 60) return `about ${s} s left`;
  return `about ${Math.floor(s / 60)} min ${s % 60} s left`;
}

/** Add or remove a language; the last one cannot be removed. */
export function toggleLanguage(selected: readonly OcrLanguage[], lang: OcrLanguage): OcrLanguage[] {
  if (!selected.includes(lang)) return [...selected, lang];
  return selected.length > 1 ? selected.filter((l) => l !== lang) : [...selected];
}
