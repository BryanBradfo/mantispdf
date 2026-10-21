/**
 * One OCR run over a document, without the UI: lanes (one per engine worker) take pages in
 * order; each page is skipped when it already has text (if asked), else rendered, recognised and
 * converted to the text layer's wire words. A page that fails at any of those steps is recorded
 * as failed and the run goes on; only a cancel (`isCancelled`, or the engine's "OCR cancelled")
 * or the engine stopping for good ends it, rejecting with that error.
 *
 * Rendering and recognition are injected (`PipelineSource`, `PipelineRecogniser`), so the run is
 * tested without pdf.js or tesseract. Workers are replaced by the engine itself (`OcrEngine`,
 * every `PAGES_PER_WORKER` pages and after a failed page).
 */
import { OCR_CANCELLED, isOcrFatal, type RecognizedPage } from "./engine";
import type { OcrPageImage } from "./render";
import { pageTextFromItems, wordsToWire } from "./run";
import { hasText } from "./text";
import type { OcrWordWire } from "./textLayerWire";

/** pdf.js text content items (`getTextContent().items`). */
export type TextItem = { str: string; hasEOL?: boolean } | { type: string };

/** The document side of a run. */
export interface PipelineSource {
  pageCount: number;
  /** Visible size of page `n` (1-based) in points. */
  pageSize(n: number): [number, number];
  /** pdf.js text items of page `n`: asked only when pages with text are skipped. */
  textItems(n: number): Promise<TextItem[]>;
  /** Page `n` rendered for OCR. */
  render(n: number): Promise<OcrPageImage>;
}

/** `OcrEngine` as the run uses it. */
export interface PipelineRecogniser {
  recognize(image: Uint8Array, onProgress?: (progress: number) => void, dpi?: number): Promise<RecognizedPage>;
}

export interface PipelineOptions {
  /** Pages read at once (the engine's worker count). */
  lanes: number;
  /** Skip pages whose pdf.js text has more than 20 non-blank characters. */
  skipText: boolean;
  /** Checked before every page: true ends the run with "OCR cancelled". */
  isCancelled?: () => boolean;
  onPageStart?: (page: number) => void;
  /** Recognition progress (0 to 1) of a page in flight. */
  onPageProgress?: (page: number, fraction: number) => void;
  onPageDone?: (result: PipelinePage) => void;
}

/** What happened to one page. */
export type PipelinePage =
  /** It already had text; `text` is that text (pdf.js), for the export. */
  | { page: number; skipped: true; text: string }
  | { page: number; skipped: false; failed: true; reason: string }
  | { page: number; skipped: false; failed: false; confidence: number; words: OcrWordWire[]; text: string };

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs OCR over every page of `source`; the results come in page order. */
export async function runPipeline(source: PipelineSource, recogniser: PipelineRecogniser, options: PipelineOptions): Promise<PipelinePage[]> {
  const results: PipelinePage[] = [];
  let next = 0;
  // A fatal error in one lane stops the others from taking new pages.
  let stop = false;
  const cancelled = () => options.isCancelled?.() ?? false;

  const readPage = async (n: number): Promise<PipelinePage> => {
    try {
      if (options.skipText) {
        const items = await source.textItems(n);
        if (hasText(items)) return { page: n, skipped: true, text: pageTextFromItems(items) };
      }
      let image: OcrPageImage | null = await source.render(n);
      const imagePx: [number, number] = [image.width, image.height];
      // The render dpi (below 300 on pages capped at the pixel limit) tells tesseract the scale.
      const job = recogniser.recognize(image.pgm, (fraction) => options.onPageProgress?.(n, fraction), image.dpi);
      // The engine copies the image: drop it now rather than hold it for the whole page.
      image = null;
      const recognised = await job;
      const words = wordsToWire(recognised.words, imagePx, source.pageSize(n));
      return { page: n, skipped: false, failed: false, confidence: recognised.confidence, words, text: recognised.text };
    } catch (e) {
      if (isOcrFatal(e)) throw e;
      return { page: n, skipped: false, failed: true, reason: reasonOf(e) };
    }
  };

  const lane = async () => {
    try {
      while (next < source.pageCount && !stop) {
        if (cancelled()) throw new Error(OCR_CANCELLED);
        const n = ++next;
        options.onPageStart?.(n);
        const result = await readPage(n);
        results.push(result);
        options.onPageDone?.(result);
      }
    } catch (e) {
      stop = true;
      throw e;
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.lanes, source.pageCount)) }, lane));
  if (cancelled()) throw new Error(OCR_CANCELLED);
  return results.sort((a, b) => a.page - b.page);
}
