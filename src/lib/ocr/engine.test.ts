import { describe, expect, it } from "vitest";
import type { Block } from "tesseract.js";
import { OCR_CANCELLED, OCR_NOT_STARTED, imageSize, isOcrCancelled, ocrAssetUrls, ocrWorkerCount, unskewWords, wordsFromBlocks, type RecognizedWord } from "./engine";
import { encodePgm } from "./render";

describe("OCR asset URLs", () => {
  it("are absolute on the app origin", () => {
    expect(ocrAssetUrls("https://mantispdf.app")).toEqual({
      workerPath: "https://mantispdf.app/ocr-runtime/worker.min.js",
      corePath: "https://mantispdf.app/ocr-runtime/core",
      langPath: "https://mantispdf.app/ocr-runtime/lang",
    });
  });
});

describe("OCR worker count", () => {
  it("is min(2, cores - 1), at least 1", () => {
    expect(ocrWorkerCount(8)).toBe(2);
    expect(ocrWorkerCount(3)).toBe(2);
    expect(ocrWorkerCount(2)).toBe(1);
    expect(ocrWorkerCount(1)).toBe(1);
    expect(ocrWorkerCount(undefined)).toBe(1);
  });
});

const bbox = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

/** A block tree with one paragraph per given list of lines. */
function blocks(lines: { baseline: { x0: number; y0: number; x1: number; y1: number }; words: { text: string; bbox: ReturnType<typeof bbox>; confidence: number }[] }[]): Block[] {
  return [{ paragraphs: [{ lines: lines.map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, symbols: [], choices: [], font_name: "" })) })) }] }] as unknown as Block[];
}

describe("words from tesseract blocks", () => {
  it("flattens blocks, paragraphs and lines in reading order with the line's baseline at the word centre", () => {
    const words = wordsFromBlocks(
      blocks([
        { baseline: bbox(100, 200, 500, 204), words: [{ text: "MANTIS", bbox: bbox(100, 160, 300, 210), confidence: 91.5 }, { text: "OCR", bbox: bbox(320, 160, 500, 210), confidence: 80 }] },
        { baseline: bbox(100, 300, 100, 300), words: [{ text: "2026", bbox: bbox(100, 260, 200, 305), confidence: 50 }] },
      ]),
    );
    expect(words).toEqual([
      { text: "MANTIS", bbox: bbox(100, 160, 300, 210), baseline: 201, confidence: 91.5, lineEnd: false },
      { text: "OCR", bbox: bbox(320, 160, 500, 210), baseline: 203.1, confidence: 80, lineEnd: true },
      { text: "2026", bbox: bbox(100, 260, 200, 305), baseline: 300, confidence: 50, lineEnd: true },
    ]);
  });

  it("drops blank words and survives missing parts", () => {
    expect(wordsFromBlocks(null)).toEqual([]);
    const words = wordsFromBlocks(blocks([{ baseline: bbox(0, 10, 100, 10), words: [{ text: "  ", bbox: bbox(0, 0, 5, 10), confidence: 1 }, { text: "a", bbox: bbox(10, 0, 20, 12), confidence: 9 }] }]));
    expect(words.map((w) => w.text)).toEqual(["a"]);
    expect(words[0].lineEnd).toBe(true);
  });
});

describe("image size", () => {
  it("reads PGM and PNG headers", () => {
    expect(imageSize(encodePgm(new Uint8Array(6), 3, 2))).toEqual([3, 2]);
    expect(imageSize(new TextEncoder().encode("P5 # scanner\n 2550\n3300 255\n"))).toEqual([2550, 3300]);
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 1800);
    new DataView(png.buffer).setUint32(20, 400);
    expect(imageSize(png)).toEqual([1800, 400]);
  });

  it("is null for anything else", () => {
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(imageSize(new TextEncoder().encode("P5\n0 10\n255\n"))).toBeNull();
    expect(imageSize(new Uint8Array())).toBeNull();
  });
});

describe("words of a deskewed page back on the page image", () => {
  const word = (x0: number, y0: number, x1: number, y1: number, baseline: number | null): RecognizedWord => ({
    text: "w",
    bbox: { x0, y0, x1, y1 },
    baseline,
    confidence: 90,
    lineEnd: true,
  });

  it("leaves words alone without rotation", () => {
    const words = [word(1, 2, 3, 4, 3.5)];
    expect(unskewWords(words, 0, [100, 100])).toEqual(words);
  });

  it("rotates boxes about the image centre by tesseract's angle (measured: a scan turned 2 degrees)", () => {
    // tesseract.js read a 2550 x 3300 scan turned 2 degrees counter-clockwise with rotateAuto: it found
    // rotateRadians 0.03516 and MANTIS at [314, 481, 946, 594] deskewed; read without rotateAuto,
    // the same word's box on the turned image is [274, 495, 908, 626].
    const [w] = unskewWords([word(314, 481, 946, 594, 590)], 0.03516174480319023, [2550, 3300]);
    const { x0, y0, x1, y1 } = w.bbox;
    for (const [got, want] of [[x0, 274], [y0, 495], [x1, 908], [y1, 626]]) expect(Math.abs(got - want)).toBeLessThanOrEqual(3);
    // The baseline at the word's centre moves with it: (630, 590) -> y 613.3.
    expect(w.baseline).toBeCloseTo(613.3, 0);
    expect(w.text).toBe("w");
  });

  it("keeps the turned box: its bottom-left corner, own size, angle and baseline rise", () => {
    const a = 0.03516174480319023;
    const [w] = unskewWords([word(314, 481, 946, 594, 590)], a, [2550, 3300]);
    const [cx, cy] = [1275, 1650];
    const [dx, dy] = [314 - cx, 594 - cy];
    expect(w.turned).toBeDefined();
    const t = w.turned!;
    expect(t.corner[0]).toBeCloseTo(cx + dx * Math.cos(a) + dy * Math.sin(a), 1);
    expect(t.corner[1]).toBeCloseTo(cy - dx * Math.sin(a) + dy * Math.cos(a), 1);
    expect(t.width).toBe(632);
    expect(t.height).toBe(113);
    expect(t.angle).toBeCloseTo((a * 180) / Math.PI, 6);
    expect(t.rise).toBe(4);
  });

  it("does not turn words without rotation", () => {
    expect(unskewWords([word(1, 2, 3, 4, 3.5)], 0, [100, 100])[0].turned).toBeUndefined();
  });
});

describe("engine error messages", () => {
  it("are exported for callers to tell cancel and start failure apart", () => {
    expect(OCR_CANCELLED).toBe("OCR cancelled");
    expect(OCR_NOT_STARTED).toBe("OCR engine could not start");
    expect(isOcrCancelled(new Error(OCR_CANCELLED))).toBe(true);
    expect(isOcrCancelled(new Error(OCR_NOT_STARTED))).toBe(false);
    expect(isOcrCancelled("OCR cancelled")).toBe(false);
  });
});
