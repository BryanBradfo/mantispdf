import { describe, expect, it } from "vitest";
import type { RecognizedWord } from "./engine";
import { LOW_QUALITY, estimateRemainingMs, formatEta, summarize, toggleLanguage, wordsToWire } from "./run";

const word = (text: string, x0: number, y0: number, x1: number, y1: number, extra: Partial<RecognizedWord> = {}): RecognizedWord => ({
  text,
  bbox: { x0, y0, x1, y1 },
  baseline: null,
  confidence: 90,
  lineEnd: false,
  ...extra,
});

describe("wordsToWire", () => {
  it("maps image pixels (y down) to visible points (y up) by the page size", () => {
    // A 612 x 792 pt page rendered 2550 x 3300 px (300 dpi): 72 / 300 = 0.24 pt per px.
    const [w] = wordsToWire([word("MANTIS", 250, 300, 750, 400, { baseline: 390, lineEnd: true })], [2550, 3300], [612, 792]);
    expect(w.text).toBe("MANTIS");
    expect(w.x).toBeCloseTo(60);
    expect(w.w).toBeCloseTo(120);
    expect(w.h).toBeCloseTo(24);
    // Bottom edge at 400 px from the top: 792 - 96 = 696 pt.
    expect(w.y).toBeCloseTo(696);
    expect(w.baseline).toBeCloseTo(792 - 390 * 0.24);
    expect(w.spaceAfter).toBe(false);
  });

  it("puts a space after every word but the last of its line", () => {
    const out = wordsToWire([word("a", 0, 0, 10, 10), word("b", 20, 0, 30, 10, { lineEnd: true })], [100, 100], [100, 100]);
    expect(out.map((w) => w.spaceAfter)).toEqual([true, false]);
    expect(out[0].baseline).toBeNull();
  });

  it("drops words the engine would refuse: empty boxes and texts over 200 UTF-16 units", () => {
    const out = wordsToWire(
      [word("ok", 0, 0, 10, 10), word("flat", 0, 5, 10, 5), word("x".repeat(201), 0, 0, 10, 10), word("😀".repeat(100), 0, 0, 10, 10)],
      [100, 100],
      [100, 100],
    );
    expect(out.map((w) => w.text.length)).toEqual([2, 200]);
  });
});

describe("summary", () => {
  it("counts processed and skipped pages, averages confidence over processed pages and flags low ones", () => {
    const s = summarize([
      { page: 1, skipped: true },
      { page: 2, skipped: false, confidence: 92, words: 10 },
      { page: 3, skipped: false, confidence: 41, words: 5 },
      { page: 4, skipped: false, confidence: 0, words: 0 },
    ]);
    expect(LOW_QUALITY).toBe(60);
    expect(s.processed).toBe(3);
    expect(s.skipped).toEqual([1]);
    expect(s.averageConfidence).toBeCloseTo((92 + 41) / 2);
    expect(s.lowQuality).toEqual([3]);
    expect(s.noText).toEqual([4]);
    expect(s.words).toBe(15);
  });

  it("has no average without recognised words", () => {
    expect(summarize([{ page: 1, skipped: true }]).averageConfidence).toBeNull();
  });
});

describe("progress", () => {
  it("estimates the time left from the pages done so far", () => {
    expect(estimateRemainingMs({ done: 0, total: 10, elapsedMs: 5000 })).toBeNull();
    expect(estimateRemainingMs({ done: 2, total: 10, elapsedMs: 4000 })).toBe(16000);
    expect(estimateRemainingMs({ done: 10, total: 10, elapsedMs: 4000 })).toBe(0);
  });

  it("formats the time left", () => {
    expect(formatEta(null)).toBe("estimating time left");
    expect(formatEta(4000)).toBe("about 4 s left");
    expect(formatEta(125000)).toBe("about 2 min 5 s left");
    expect(formatEta(0)).toBe("almost done");
  });
});

describe("language selection", () => {
  it("toggles a language, never leaving none", () => {
    expect(toggleLanguage(["eng"], "fra")).toEqual(["eng", "fra"]);
    expect(toggleLanguage(["eng", "fra"], "eng")).toEqual(["fra"]);
    expect(toggleLanguage(["eng"], "eng")).toEqual(["eng"]);
  });
});
