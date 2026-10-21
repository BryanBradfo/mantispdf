import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * tesseract.js mocked: each created worker is recorded with its options; tests script how
 * `createWorker`, `reinitialize` and `recognize` behave.
 */
interface FakeWorker {
  id: string;
  options: Record<string, unknown>;
  langs: unknown;
  reinitialize: ReturnType<typeof vi.fn>;
  setParameters: ReturnType<typeof vi.fn>;
  recognize: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}
const workers: FakeWorker[] = [];
let createBehaviour: (w: FakeWorker) => Promise<FakeWorker> = async (w) => w;
let reinitBehaviour: () => Promise<unknown> = async () => ({});
let recognizeBehaviour: (w: FakeWorker, jobId: string) => Promise<unknown> = async () => ({ data: { text: "", blocks: [] } });

vi.mock("tesseract.js", () => ({
  OEM: { LSTM_ONLY: 1 },
  PSM: { AUTO: "3" },
  createWorker: vi.fn((langs: unknown, _oem: unknown, options: Record<string, unknown>) => {
    const w: FakeWorker = {
      id: `w${workers.length + 1}`,
      options,
      langs,
      reinitialize: vi.fn(() => reinitBehaviour()),
      setParameters: vi.fn(async () => ({})),
      recognize: vi.fn((_img: unknown, _o: unknown, _out: unknown, jobId: string) => recognizeBehaviour(w, jobId)),
      terminate: vi.fn(async () => {}),
    };
    workers.push(w);
    return createBehaviour(w);
  }),
}));

const { OcrEngine } = await import("./engine");
const ORIGIN = "https://app.test";
const never = () => new Promise<never>(() => {});
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  workers.length = 0;
  createBehaviour = async (w) => w;
  reinitBehaviour = async () => ({});
  recognizeBehaviour = async () => ({ data: { text: "", blocks: [] } });
  vi.useRealTimers();
});

describe("OcrEngine.create", () => {
  it("creates bare LSTM workers on the origin, then loads the languages with reinitialize", async () => {
    await OcrEngine.create(["eng", "fra"], { workers: 2, origin: ORIGIN });
    expect(workers).toHaveLength(2);
    for (const w of workers) {
      expect(w.langs).toEqual([]);
      expect(w.options).toMatchObject({
        workerPath: `${ORIGIN}/ocr-runtime/worker.min.js`,
        corePath: `${ORIGIN}/ocr-runtime/core`,
        langPath: `${ORIGIN}/ocr-runtime/lang`,
        workerBlobURL: false,
        gzip: true,
      });
      // Without an errorHandler, tesseract.js throws worker rejections as uncaught errors.
      expect(typeof w.options.errorHandler).toBe("function");
      expect(w.reinitialize).toHaveBeenCalledWith("eng+fra", 1);
      // Automatic page segmentation (the library default is a single block).
      expect(w.setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: "3" });
    }
  });

  it("a language that fails to load rejects and terminates every worker", async () => {
    reinitBehaviour = async () => {
      throw new Error("Network error while fetching fra.traineddata.gz");
    };
    await expect(OcrEngine.create(["eng", "fra"], { workers: 2, origin: ORIGIN })).rejects.toThrow("OCR engine could not start");
    expect(workers).toHaveLength(2);
    for (const w of workers) expect(w.terminate).toHaveBeenCalled();
  });

  it("aborting while a worker never starts rejects as cancelled and terminates the others", async () => {
    let n = 0;
    createBehaviour = (w) => (++n === 1 ? Promise.resolve(w) : never());
    reinitBehaviour = never; // model download in progress
    const abort = new AbortController();
    const created = OcrEngine.create(["eng"], { workers: 2, origin: ORIGIN, signal: abort.signal });
    await tick();
    abort.abort();
    await expect(created).rejects.toThrow("OCR cancelled");
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it("a worker that starts after the failure is terminated too", async () => {
    let release: (w: FakeWorker) => void = () => {};
    let n = 0;
    createBehaviour = (w) => (++n === 2 ? new Promise((r) => (release = () => r(w))) : Promise.resolve(w));
    const abort = new AbortController();
    const created = OcrEngine.create(["eng"], { workers: 2, origin: ORIGIN, signal: abort.signal });
    await tick();
    abort.abort();
    await expect(created).rejects.toThrow("OCR cancelled");
    release(workers[1]);
    await tick();
    expect(workers[1].terminate).toHaveBeenCalled();
    expect(workers[1].reinitialize).not.toHaveBeenCalled();
  });

  it("an already aborted signal starts nothing", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(OcrEngine.create(["eng"], { workers: 2, origin: ORIGIN, signal: abort.signal })).rejects.toThrow("OCR cancelled");
    expect(workers).toHaveLength(0);
  });

  it("gives up after 120 s by default", async () => {
    vi.useFakeTimers();
    reinitBehaviour = never;
    const created = OcrEngine.create(["eng"], { workers: 1, origin: ORIGIN });
    const outcome = created.then(() => "started", (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("OCR engine could not start");
    expect(workers[0].terminate).toHaveBeenCalled();
  });
});

describe("OcrEngine start progress", () => {
  it("is one language-loading figure for the whole pool, never going back", async () => {
    const seen: { status: string; progress: number }[] = [];
    const releases: (() => void)[] = [];
    reinitBehaviour = () => new Promise((r) => releases.push(() => r({})));
    const started = OcrEngine.create(["eng", "fra"], { workers: 2, origin: ORIGIN, onProgress: (p) => seen.push(p) });
    await tick();
    const log = workers[0].options.logger as (m: object) => void;
    const lang = "loading language traineddata";
    // Each worker reports its own progress; the pool's is their mean.
    log({ workerId: "Worker-1", status: lang, progress: 0.5 });
    log({ workerId: "Worker-1", status: lang, progress: 1 });
    log({ workerId: "Worker-2", status: lang, progress: 0.5 });
    log({ workerId: "Worker-2", status: lang, progress: 0 }); // a late, lower report
    log({ workerId: "Worker-2", status: lang, progress: 1 });
    expect(seen.filter((p) => p.status === lang).map((p) => p.progress)).toEqual([0.25, 0.5, 0.75, 0.75, 1]);
    // Other start-up messages pass through.
    log({ workerId: "Worker-1", status: "initializing api", progress: 1 });
    expect(seen[seen.length - 1]).toEqual({ status: "initializing api", progress: 1 });
    for (const r of releases) r();
    await started;
  });
});

describe("OcrEngine.recognize", () => {
  it("deskews automatically and puts the words back on the page image", async () => {
    const block = (bbox: object) => [{ paragraphs: [{ lines: [{ baseline: { x0: 0, y0: 0, x1: 0, y1: 0 }, words: [{ text: "MANTIS", bbox, confidence: 90 }] }] }] }];
    recognizeBehaviour = async () => ({ data: { text: "MANTIS", blocks: block({ x0: 314, y0: 481, x1: 946, y1: 594 }), rotateRadians: 0.03516174480319023 } });
    const engine = await OcrEngine.create(["eng"], { workers: 1, origin: ORIGIN });
    const page = await engine.recognize(new TextEncoder().encode("P5\n2550 3300\n255\n"));
    expect(workers[0].recognize.mock.calls[0][1]).toEqual({ rotateAuto: true, user_defined_dpi: "300" });
    expect(page.words[0].bbox.x0).toBeCloseTo(273.5, 0);
    expect(page.words[0].bbox.y1).toBeCloseTo(628.4, 0);
  });

  it("does not deskew an image whose size it cannot read (boxes could not be put back)", async () => {
    const engine = await OcrEngine.create(["eng"], { workers: 1, origin: ORIGIN });
    await engine.recognize(new Uint8Array([0xff, 0xd8, 0xff]), undefined, 150);
    expect(workers[0].recognize.mock.calls[0][1]).toEqual({ user_defined_dpi: "150" });
  });

  it("reports each page's progress to its own callback", async () => {
    recognizeBehaviour = async (w, jobId) => {
      const logger = w.options.logger as (m: object) => void;
      logger({ workerId: w.id, jobId, userJobId: jobId, status: "recognizing text", progress: 0.5 });
      return { data: { text: "x", blocks: [] } };
    };
    const engine = await OcrEngine.create(["eng"], { workers: 2, origin: ORIGIN });
    const a: number[] = [];
    const b: number[] = [];
    await Promise.all([engine.recognize(new Uint8Array([1]), (p) => a.push(p)), engine.recognize(new Uint8Array([2]), (p) => b.push(p))]);
    expect(a).toEqual([0.5]);
    expect(b).toEqual([0.5]);
  });

  it("runs one page per worker at a time", async () => {
    const releases: (() => void)[] = [];
    recognizeBehaviour = () => new Promise((r) => releases.push(() => r({ data: { text: "", blocks: [] } })));
    const engine = await OcrEngine.create(["eng"], { workers: 1, origin: ORIGIN });
    const first = engine.recognize(new Uint8Array([1]));
    const second = engine.recognize(new Uint8Array([2]));
    await tick();
    expect(workers[0].recognize).toHaveBeenCalledTimes(1);
    releases[0]();
    await first;
    await tick();
    expect(workers[0].recognize).toHaveBeenCalledTimes(2);
    releases[1]();
    await second;
  });

  it("terminate rejects running and queued pages and every later one", async () => {
    recognizeBehaviour = never;
    const engine = await OcrEngine.create(["eng"], { workers: 1, origin: ORIGIN });
    const running = engine.recognize(new Uint8Array([1]));
    const queued = engine.recognize(new Uint8Array([2]));
    await engine.terminate();
    await expect(running).rejects.toThrow("OCR cancelled");
    await expect(queued).rejects.toThrow("OCR cancelled");
    await expect(engine.recognize(new Uint8Array([3]))).rejects.toThrow("OCR cancelled");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    await engine.terminate();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
});
