/**
 * Text recognition with tesseract.js, entirely on the app origin: the worker script, the core
 * and the language models are the files `scripts/copy-ocr-assets.mjs` puts under `/ocr/`
 * (absolute URLs, no blob: worker), so no request leaves the origin.
 */
import { OEM, createScheduler, createWorker, type Block, type Scheduler } from "tesseract.js";
import { OCR_BASE, OCR_WORKER_FILE } from "./assets";
import type { OcrLanguage } from "./languages";

/** A recognised word; boxes and baseline in image pixels (y down). */
export interface RecognizedWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** The line's baseline at the word's centre, when tesseract gives one. */
  baseline: number | null;
  confidence: number;
  /** Last word of its line. */
  lineEnd: boolean;
}

export interface RecognizedPage {
  words: RecognizedWord[];
  text: string;
  /** Mean word confidence (0-100). */
  confidence: number;
}

export function ocrAssetUrls(origin: string): { workerPath: string; corePath: string; langPath: string } {
  return {
    workerPath: `${origin}${OCR_BASE}/${OCR_WORKER_FILE}`,
    corePath: `${origin}${OCR_BASE}/core`,
    langPath: `${origin}${OCR_BASE}/lang`,
  };
}

/** Workers to run: min(2, cores - 1), at least one. */
export function ocrWorkerCount(hardwareConcurrency: number | undefined): number {
  return Math.max(1, Math.min(2, (hardwareConcurrency ?? 1) - 1));
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The words of tesseract's block tree in reading order (blank words dropped). */
export function wordsFromBlocks(blocks: Block[] | null): RecognizedWord[] {
  const out: RecognizedWord[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const words = (line.words ?? []).filter((w) => w.text.trim() !== "");
        const b = line.baseline;
        words.forEach((w, i) => {
          let baseline: number | null = null;
          if (b && [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) {
            const centre = (w.bbox.x0 + w.bbox.x1) / 2;
            baseline = b.x1 === b.x0 ? b.y0 : round2(b.y0 + ((b.y1 - b.y0) * (centre - b.x0)) / (b.x1 - b.x0));
          }
          out.push({ text: w.text, bbox: { ...w.bbox }, baseline, confidence: w.confidence, lineEnd: i === words.length - 1 });
        });
      }
    }
  }
  return out;
}

export interface OcrProgress {
  status: string;
  progress: number;
}

/** A pool of tesseract workers for `langs`. `terminate` stops everything; pending pages reject. */
export class OcrEngine {
  private terminated = false;
  private readonly cancelled: Promise<never>;
  private cancel: (e: Error) => void = () => {};

  private constructor(private readonly scheduler: Scheduler) {
    this.cancelled = new Promise<never>((_, reject) => {
      this.cancel = reject;
    });
    // Rejected on terminate whether or not a page is pending.
    this.cancelled.catch(() => {});
  }

  static async create(langs: readonly OcrLanguage[], options: { workers: number; origin: string; onProgress?: (p: OcrProgress) => void }): Promise<OcrEngine> {
    const scheduler = createScheduler();
    try {
      const urls = ocrAssetUrls(options.origin);
      const workers = await Promise.all(
        Array.from({ length: options.workers }, () =>
          createWorker([...langs], OEM.LSTM_ONLY, {
            ...urls,
            workerBlobURL: false,
            gzip: true,
            logger: (m) => options.onProgress?.({ status: m.status, progress: m.progress }),
          }),
        ),
      );
      for (const w of workers) scheduler.addWorker(w);
    } catch (e) {
      await scheduler.terminate();
      throw e;
    }
    return new OcrEngine(scheduler);
  }

  /**
   * Recognise one page image (PGM, PNG or any format leptonica reads). Rejects with "OCR
   * cancelled" once `terminate` is called.
   */
  async recognize(image: Uint8Array): Promise<RecognizedPage> {
    if (this.terminated) throw new Error("OCR cancelled");
    // tesseract.js types its inputs as DOM images or Node Buffers; a Uint8Array is read as bytes.
    const job = this.scheduler.addJob("recognize", image as unknown as Blob, {}, { text: true, blocks: true });
    // A job cut off by terminate may reject later, or never settle: it is abandoned.
    job.catch(() => {});
    const { data } = await Promise.race([job, this.cancelled]);
    const words = wordsFromBlocks(data.blocks);
    const confidence = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 0;
    return { words, text: data.text, confidence };
  }

  async terminate(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    this.cancel(new Error("OCR cancelled"));
    await this.scheduler.terminate();
  }
}
