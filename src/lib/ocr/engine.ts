/**
 * Text recognition with tesseract.js, entirely on the app origin: the worker script, the core
 * and the language models are the files `scripts/copy-ocr-assets.mjs` puts under `/ocr/`
 * (absolute URLs, no blob: worker), so no request leaves the origin.
 */
import { OEM, PSM, createWorker, type Block, type LoggerMessage, type Worker } from "tesseract.js";
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
  /**
   * Set when the page was deskewed: the word's own box, turned. `corner` is its bottom-left
   * corner on the page image (px, y down), `width` and `height` its size along and across its
   * baseline, `angle` the baseline's turn in degrees (counter-clockwise as seen), `rise` the
   * baseline's height above the box's bottom edge (px; null when unknown). `bbox` and `baseline`
   * above are then the upright approximations.
   */
  turned?: { corner: [number, number]; width: number; height: number; angle: number; rise: number | null };
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

/**
 * Pixel size `[width, height]` of a binary PGM (P5) or a PNG, from its header; null for anything
 * else.
 */
export function imageSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size: [number, number] = [view.getUint32(16), view.getUint32(20)];
    return size[0] > 0 && size[1] > 0 ? size : null;
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x35) return null;
  // "P5", then width and height as decimal tokens; whitespace and # comments between.
  const header = new TextDecoder("latin1").decode(bytes.subarray(2, Math.min(bytes.length, 512)));
  const tokens = header.replace(/#[^\n\r]*/g, " ").trim().split(/\s+/);
  const [w, h] = [Number(tokens[0]), Number(tokens[1])];
  return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? [w, h] : null;
}

/**
 * Words tesseract read on a page it deskewed by `angle` radians (`rotateRadians` of a
 * `rotateAuto` recognition), back on the page image of `size` pixels: tesseract rotates the
 * image about its centre, so each box is rotated back about it: `turned` keeps the turned box
 * (for a text layer that follows the skew), `bbox` becomes the axis-aligned box of its corners
 * and `baseline` the one at the word's centre, rotated back the same way.
 */
export function unskewWords(words: RecognizedWord[], angle: number, [width, height]: [number, number]): RecognizedWord[] {
  if (!angle) return words;
  const [cx, cy, cos, sin] = [width / 2, height / 2, Math.cos(angle), Math.sin(angle)];
  const back = (x: number, y: number): [number, number] => {
    const [dx, dy] = [x - cx, y - cy];
    return [cx + dx * cos + dy * sin, cy - dx * sin + dy * cos];
  };
  return words.map((w) => {
    const { x0, y0, x1, y1 } = w.bbox;
    const corners = [back(x0, y0), back(x1, y0), back(x0, y1), back(x1, y1)];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const baseline = w.baseline === null ? null : round2(back((x0 + x1) / 2, w.baseline)[1]);
    const corner = back(x0, y1);
    return {
      ...w,
      bbox: { x0: round2(Math.min(...xs)), y0: round2(Math.min(...ys)), x1: round2(Math.max(...xs)), y1: round2(Math.max(...ys)) },
      baseline,
      turned: {
        corner: [round2(corner[0]), round2(corner[1])],
        width: x1 - x0,
        height: y1 - y0,
        angle: (angle * 180) / Math.PI,
        rise: w.baseline === null ? null : round2(y1 - w.baseline),
      },
    };
  });
}

export interface OcrProgress {
  status: string;
  progress: number;
}

/** Resolution assumed for page images when `recognize` is not told (render.ts renders at 300 dpi). */
export const DEFAULT_DPI = 300;

/** How long `OcrEngine.create` may take (worker, core and model downloads) before giving up. */
export const CREATE_TIMEOUT_MS = 120_000;
/** The message of every error that means the user (or the page) cancelled OCR. */
export const OCR_CANCELLED = "OCR cancelled";
/** The message of `OcrEngine.create` failing: a model that would not load, or the start timeout. */
export const OCR_NOT_STARTED = "OCR engine could not start";
const CANCELLED = OCR_CANCELLED;
const NOT_STARTED = OCR_NOT_STARTED;

/** An error that only means OCR was cancelled. */
export function isOcrCancelled(e: unknown): boolean {
  return e instanceof Error && e.message === OCR_CANCELLED;
}

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
      // Automatic page segmentation, like the tesseract CLI (the library's own default is a
      // single block, which reads tables and multi-column pages badly); it is also the mode
      // rotateAuto measures the skew with.
      await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
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
   * Recognise one page image (PGM, PNG or any format leptonica reads) rendered at `dpi`.
   * `onProgress` receives this page's recognition progress (0 to 1). Rejects with "OCR cancelled" once `terminate`
   * is called.
   */
  async recognize(image: Uint8Array, onProgress?: (progress: number) => void, dpi = DEFAULT_DPI): Promise<RecognizedPage> {
    if (this.terminated) throw new Error(CANCELLED);
    // Skewed scans read far better deskewed (measured on real scans), but tesseract then reports
    // boxes on the deskewed image: only deskew when they can be put back (the size is known).
    const size = imageSize(image);
    const run = (async () => {
      const w = await this.acquire();
      if (this.terminated) throw new Error(CANCELLED);
      const jobId = `ocr-page-${++this.jobs}`;
      if (onProgress) this.pageProgress.set(jobId, onProgress);
      try {
        // tesseract.js types its inputs as DOM images or Node Buffers; a Uint8Array is read as bytes.
        // The image's resolution: tesseract cannot read it from a PGM and would guess it (and log
        // "Estimating resolution as ..." to the console).
        const options = { user_defined_dpi: String(Math.round(dpi)), ...(size ? { rotateAuto: true } : {}) };
        return await w.recognize(image as unknown as Blob, options, { text: true, blocks: true }, jobId);
      } finally {
        this.pageProgress.delete(jobId);
        if (!this.terminated) this.release(w);
      }
    })();
    // A page cut off by terminate may reject later, or never settle: it is abandoned.
    run.catch(() => {});
    const { data } = await Promise.race([run, this.cancelled]);
    const angle = (data as { rotateRadians?: number | null }).rotateRadians ?? 0;
    const words = size ? unskewWords(wordsFromBlocks(data.blocks), angle, size) : wordsFromBlocks(data.blocks);
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
