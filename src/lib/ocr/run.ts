/** The OCR page's pure parts: recognised words to the engine's wire, the summary, progress. */
import type { RecognizedWord } from "./engine";
import type { OcrLanguage } from "./languages";
import type { PipelinePage } from "./pipeline";
import type { OcrWordWire } from "./textLayerWire";
import type { NsT } from "../../i18n";

/** Pages whose mean word confidence is below this are flagged as low quality scans. */
export const LOW_QUALITY = 60;
/** The engine's limits on a word (`add_text_layer`). */
const MAX_WORD_UNITS = 200;
const MIN_BOX_PT = 0.01;

/**
 * Words recognised on an image of `imagePx` pixels (y down) to visible-space points (y up) on a
 * page of `pagePt` points. A space follows every word but the last of its line. Words the engine
 * would refuse (box under 0.01 pt, text over 200 UTF-16 units) are dropped.
 *
 * The mapping is proportional: the image is pdf.js's render of the visible box, `pagePt` the
 * engine's visible size. Both clip the CropBox to the MediaBox (the MediaBox when they do not
 * overlap), apply /Rotate and ignore /UserUnit, so they are the same box (pageBox.test.ts).
 */
export function wordsToWire(words: readonly RecognizedWord[], imagePx: [number, number], pagePt: [number, number]): OcrWordWire[] {
  const sx = pagePt[0] / imagePx[0];
  const sy = pagePt[1] / imagePx[1];
  const out: OcrWordWire[] = [];
  for (const word of words) {
    if (word.turned) {
      // A deskewed word: its own box from its turned bottom-left corner (page images have the
      // same scale on both axes), the baseline in its own frame.
      const t = word.turned;
      const w = t.width * sx;
      const h = t.height * sy;
      if (!(w >= MIN_BOX_PT && h >= MIN_BOX_PT) || word.text.length > MAX_WORD_UNITS) continue;
      const y = pagePt[1] - t.corner[1] * sy;
      out.push({
        text: word.text,
        x: t.corner[0] * sx,
        y,
        w,
        h,
        baseline: t.rise === null ? null : y + t.rise * sy,
        spaceAfter: !word.lineEnd,
        angle: t.angle,
      });
      continue;
    }
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

export function formatEta(ms: number | null, t: NsT<"ocr">): string {
  if (ms === null) return t("etaEstimating");
  const s = Math.round(ms / 1000);
  if (s <= 0) return t("etaAlmostDone");
  if (s < 60) return t("etaSeconds", { s });
  return t("etaMinutes", { m: Math.floor(s / 60), s: s % 60 });
}

/** Add or remove a language; the last one cannot be removed. */
export function toggleLanguage(selected: readonly OcrLanguage[], lang: OcrLanguage): OcrLanguage[] {
  if (!selected.includes(lang)) return [...selected, lang];
  return selected.length > 1 ? selected.filter((l) => l !== lang) : [...selected];
}

/** The engine's word limits (`add_text_layer`): per page and for the whole job. */
export const MAX_WORDS_PER_PAGE = 200_000;
export const MAX_WORDS_TOTAL = 2_000_000;

/** Why the text layer cannot be added (too many words), in plain words; null when it can. */
export function wordLimitProblem(pages: readonly { page: number; words: readonly unknown[] }[], t: NsT<"ocr">): string | null {
  let total = 0;
  for (const p of pages) {
    if (p.words.length > MAX_WORDS_PER_PAGE) {
      return t("wordsPerPage", { page: p.page, max: MAX_WORDS_PER_PAGE });
    }
    total += p.words.length;
  }
  if (total > MAX_WORDS_TOTAL) {
    return t("wordsTotal", { max: MAX_WORDS_TOTAL });
  }
  return null;
}

/** "page 3" / "pages 2, 5". */
export function pageList(pages: readonly number[], t: NsT<"ocr">): string {
  return t("pageList", { count: pages.length, list: pages.join(", ") });
}

/** The summary's first line. */
export function summaryHeadline(s: OcrSummary, t: NsT<"ocr">): string {
  if (s.processed === 0 && s.skipped.length > 0) return t("allHaveText", { hint: t("skipHint") });
  const pages = s.processed - s.noText.length;
  return t("headline", { pages: t("headlinePages", { count: pages }), words: t("headlineWords", { count: s.words }) });
}

/** The summary line for skipped pages. */
export function skippedLine(pages: readonly number[], t: NsT<"ocr">): string {
  return t("skippedLine", { pages: pageList(pages, t), hint: t("skipHint") });
}

/** What the page shows while the engine starts: the language data download as a percentage. */
export function loadingLabel(p: { status: string; progress: number } | null, t: NsT<"ocr">): string {
  if (p && /language/i.test(p.status)) return t("loadingData", { percent: Math.round(Math.min(1, Math.max(0, p.progress)) * 100) });
  return t("starting");
}

/** pdf.js text content items as plain text: items in order, a line break after each end of line. */
export function pageTextFromItems(items: readonly ({ str: string; hasEOL?: boolean } | { type: string })[]): string {
  let out = "";
  for (const item of items) {
    if (!("str" in item)) continue;
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return out.replace(/\s+$/, "");
}

/** Recognised and skipped pages' text together, in page order, for the .txt of the whole document. */
export function wholeDocumentText(
  recognised: readonly { page: number; text: string }[],
  skipped: readonly { page: number; text: string }[],
): { page: number; text: string }[] {
  return [...recognised, ...skipped].sort((a, b) => a.page - b.page);
}

/** What the page keeps of a pipeline run. */
export interface OcrRunResult {
  outcomes: PageOutcome[];
  /** Pages with recognised words, for the text layer. */
  layer: { page: number; words: OcrWordWire[] }[];
  /** Recognised text per processed page. */
  texts: { page: number; text: string }[];
  /** pdf.js text of the pages skipped because they had text. */
  skippedTexts: { page: number; text: string }[];
  /** Pages that could not be read (render or recognition failed). */
  failed: number[];
}

/** A pipeline run (`runPipeline`, in page order) as the page shows and downloads it. */
export function fromPipeline(pages: readonly PipelinePage[]): OcrRunResult {
  const r: OcrRunResult = { outcomes: [], layer: [], texts: [], skippedTexts: [], failed: [] };
  for (const p of pages) {
    if (p.skipped) {
      r.outcomes.push({ page: p.page, skipped: true });
      r.skippedTexts.push({ page: p.page, text: p.text });
    } else if (p.failed) {
      r.failed.push(p.page);
    } else {
      r.outcomes.push({ page: p.page, skipped: false, confidence: p.confidence, words: p.words.length });
      if (p.words.length > 0) r.layer.push({ page: p.page, words: p.words });
      r.texts.push({ page: p.page, text: p.text });
    }
  }
  return r;
}

export const failedLine = (pages: readonly number[], t: NsT<"ocr">): string => t("failedLine", { pages: pageList(pages, t) });

/** Pages a second pass left alone because they already had an OCR text layer. */
export const alreadyOcrLine = (pages: readonly number[], t: NsT<"ocr">): string =>
  t("alreadyOcr", { count: pages.length, list: pages.join(", ") });
