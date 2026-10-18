/**
 * Text recognition with tesseract.js, entirely on the app origin: the worker script, the core
 * and the language models are the files `scripts/copy-ocr-assets.mjs` puts under `/ocr/`
 * (absolute URLs, no blob: worker), so no request leaves the origin.
 */
import { OEM, createWorker, type Block, type LoggerMessage, type Worker } from "tesseract.js";
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

/** How long `OcrEngine.create` may take (worker, core and model downloads) before giving up. */
export const CREATE_TIMEOUT_MS = 120_000;
const CANCELLED = "OCR cancelled";
const NOT_STARTED = "OCR engine could not start";

export interface OcrEngineOptions {
  workers: number;
  /** The app origin the runtime files are served from. */
  origin: string;
  /** Aborting stops the start (workers terminated) with "OCR cancelled". */
  signal?: AbortSignal;
  /** Start progress (core and model loading), from every worker. */
  onProgress?: (p: OcrProgress) => void;
  timeoutMs?: number;
}

/**
 * A pool of tesseract workers for `langs`, one page per worker at a time. `terminate` stops
 * everything; running, queued and later pages reject with "OCR cancelled".
 *
 * Image bytes are not transferred: tesseract.js copies the given bytes (`new Uint8Array(data)`)
 * and posts them to its worker without a transfer list (worker/browser/send.js), so callers
 * should drop their reference to a page image once `recognize` has been called.
 */
export class OcrEngine {
  private terminated = false;
  private readonly cancelled: Promise<never>;
  private cancel: (e: Error) => void = () => {};
  private readonly idle: Worker[];
  private readonly waiting: ((w: Worker) => void)[] = [];
  private jobs = 0;

  private constructor(
    private readonly workers: Worker[],
    private readonly pageProgress: Map<string, (progress: number) => void>,
  ) {
    this.idle = [...workers];
    this.cancelled = new Promise<never>((_, reject) => {
      this.cancel = reject;
    });
    // Rejected on terminate whether or not a page is pending.
    this.cancelled.catch(() => {});
  }

  /**
   * Starts `options.workers` workers with `langs` loaded. Workers are created bare and load the
   * languages through `reinitialize`, because tesseract.js 7 never rejects `createWorker` when
   * a language fails to load or initialise. Any failure, abort or the timeout terminates every
   * worker started so far (and any that starts later).
   */
  static async create(langs: readonly OcrLanguage[], options: OcrEngineOptions): Promise<OcrEngine> {
    if (options.signal?.aborted) throw new Error(CANCELLED);
    const urls = ocrAssetUrls(options.origin);
    const pageProgress = new Map<string, (progress: number) => void>();
    const logger = (m: LoggerMessage) => {
      const page = m.userJobId ? pageProgress.get(m.userJobId) : undefined;
      if (page) page(m.progress);
      else options.onProgress?.({ status: m.status, progress: m.progress });
    };
    const started: Worker[] = [];
    let failed = false;
    const stopAll = () => {
      failed = true;
      for (const w of started) void w.terminate();
    };
    const start = async () => {
      const w = await createWorker([], OEM.LSTM_ONLY, {
        ...urls,
        workerBlobURL: false,
        gzip: true,
        logger,
        // The failing job's promise rejects; this only stops tesseract.js throwing it again.
        errorHandler: () => {},
      });
      started.push(w);
      if (failed) {
        void w.terminate();
        throw new Error(CANCELLED);
      }
      await w.reinitialize(langs.join("+"), OEM.LSTM_ONLY);
      return w;
    };

    let onAbort = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(CANCELLED));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(new Error(NOT_STARTED)), options.timeoutMs ?? CREATE_TIMEOUT_MS);
    });
    const all = Promise.all(Array.from({ length: options.workers }, start));
    all.catch(() => {});
    try {
      const workers = await Promise.race([all, stop]);
      return new OcrEngine(workers, pageProgress);
    } catch (e) {
      stopAll();
      if (e instanceof Error && (e.message === CANCELLED || e.message === NOT_STARTED)) throw e;
      throw Object.assign(new Error(NOT_STARTED), { cause: e });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private acquire(): Promise<Worker> {
    const w = this.idle.pop();
    return w ? Promise.resolve(w) : new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(w: Worker) {
    const next = this.waiting.shift();
    if (next) next(w);
    else this.idle.push(w);
  }

  /**
   * Recognise one page image (PGM, PNG or any format leptonica reads). `onProgress` receives
   * this page's recognition progress (0 to 1). Rejects with "OCR cancelled" once `terminate`
   * is called.
   */
  async recognize(image: Uint8Array, onProgress?: (progress: number) => void): Promise<RecognizedPage> {
    if (this.terminated) throw new Error(CANCELLED);
    const run = (async () => {
      const w = await this.acquire();
      if (this.terminated) throw new Error(CANCELLED);
      const jobId = `ocr-page-${++this.jobs}`;
      if (onProgress) this.pageProgress.set(jobId, onProgress);
      try {
        // tesseract.js types its inputs as DOM images or Node Buffers; a Uint8Array is read as bytes.
        return await w.recognize(image as unknown as Blob, {}, { text: true, blocks: true }, jobId);
      } finally {
        this.pageProgress.delete(jobId);
        if (!this.terminated) this.release(w);
      }
    })();
    // A page cut off by terminate may reject later, or never settle: it is abandoned.
    run.catch(() => {});
    const { data } = await Promise.race([run, this.cancelled]);
    const words = wordsFromBlocks(data.blocks);
    const confidence = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 0;
    return { words, text: data.text, confidence };
  }

  async terminate(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    this.cancel(new Error(CANCELLED));
    this.waiting.length = 0;
    this.pageProgress.clear();
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
