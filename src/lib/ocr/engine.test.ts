import { describe, expect, it } from "vitest";
import type { Block } from "tesseract.js";
import { ocrAssetUrls, ocrWorkerCount, wordsFromBlocks } from "./engine";

describe("OCR asset URLs", () => {
  it("are absolute on the app origin", () => {
    expect(ocrAssetUrls("https://mantispdf.app")).toEqual({
      workerPath: "https://mantispdf.app/ocr/worker.min.js",
      corePath: "https://mantispdf.app/ocr/core",
      langPath: "https://mantispdf.app/ocr/lang",
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
