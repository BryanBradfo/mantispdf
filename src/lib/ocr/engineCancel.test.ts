import { describe, expect, it, vi } from "vitest";

// A scheduler whose jobs never settle (a worker busy on a big page), and workers that record
// how they were created.
const created: unknown[][] = [];
const terminated = vi.fn(async () => {});
vi.mock("tesseract.js", () => ({
  OEM: { LSTM_ONLY: 1 },
  createWorker: vi.fn(async (...args: unknown[]) => {
    created.push(args);
    return { id: `w${created.length}` };
  }),
  createScheduler: () => ({
    addWorker: vi.fn(),
    addJob: () => new Promise(() => {}),
    terminate: terminated,
  }),
}));

const { OcrEngine } = await import("./engine");

describe("OcrEngine", () => {
  it("creates LSTM-only workers on the origin, without blob: workers", async () => {
    created.length = 0;
    await OcrEngine.create(["eng", "fra"], { workers: 2, origin: "https://app.test" });
    expect(created).toHaveLength(2);
    const [langs, oem, options] = created[0] as [string[], number, Record<string, unknown>];
    expect(langs).toEqual(["eng", "fra"]);
    expect(oem).toBe(1);
    expect(options).toMatchObject({
      workerPath: "https://app.test/ocr/worker.min.js",
      corePath: "https://app.test/ocr/core",
      langPath: "https://app.test/ocr/lang",
      workerBlobURL: false,
      gzip: true,
    });
  });

  it("terminate rejects the pending page and every later one", async () => {
    const engine = await OcrEngine.create(["eng"], { workers: 1, origin: "https://app.test" });
    const pending = engine.recognize(new Uint8Array([1]));
    await engine.terminate();
    await expect(pending).rejects.toThrow("OCR cancelled");
    await expect(engine.recognize(new Uint8Array([1]))).rejects.toThrow("OCR cancelled");
    expect(terminated).toHaveBeenCalledTimes(1);
    await engine.terminate();
    expect(terminated).toHaveBeenCalledTimes(1);
  });
});
