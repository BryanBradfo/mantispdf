// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractWords, wordsFromRuns, type PdfLike } from "./extract";
import type { TextRun } from "../redact/search";
import type { Word } from "./types";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Pdfjs;
beforeAll(async () => {
  pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as Pdfjs;
});

async function load(name: string): Promise<PdfLike> {
  const bytes = readFileSync(fileURLToPath(new URL(`../../../e2e/fixtures/${name}`, import.meta.url)));
  return (await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise) as unknown as PdfLike;
}
const texts = (ws: Word[]) => ws.map((w) => w.text);
const run = (str: string, e: number, f: number, width: number, extra: Partial<TextRun> = {}): TextRun => ({
  str,
  transform: [10, 0, 0, 10, e, f],
  width,
  hasEOL: false,
  ...extra,
});
const geo = { view: [0, 0, 200, 100] as [number, number, number, number], rotate: 0 };

describe("wordsFromRuns", () => {
  it("splits on whitespace with proportional widths", () => {
    const ws = wordsFromRuns([run("ab cdef", 10, 20, 70)], geo, 3);
    expect(ws.map((w) => [w.text, w.page])).toEqual([["ab", 3], ["cdef", 3]]);
    // 7 chars over 70 units: "ab" = [10,30], "cdef" = [40,80]
    expect(ws[0].box.x).toBeCloseTo(10);
    expect(ws[0].box.w).toBeCloseTo(20);
    expect(ws[1].box.x).toBeCloseTo(40);
    expect(ws[1].box.w).toBeCloseTo(40);
    // size 10: from 0.25 em below the baseline to 1 em above
    expect(ws[0].box.y).toBeCloseTo(17.5);
    expect(ws[0].box.h).toBeCloseTo(12.5);
  });
  it("skips blank runs and handles NBSP as a separator", () => {
    expect(wordsFromRuns([run(" ", 0, 0, 3), run("", 0, 0, 0), run("a b", 0, 0, 30)], geo, 0).map((w) => w.text)).toEqual(["a", "b"]);
  });
  it("is rotation aware (visible space, bottom-left origin)", () => {
    // 90 degree page, text running up the user-space y axis
    const g = { view: [0, 0, 200, 100] as [number, number, number, number], rotate: 90 };
    const r: TextRun = { str: "ab cd", transform: [0, 10, -10, 0, 50, 20], width: 50, hasEOL: false };
    const [w1, w2] = wordsFromRuns([r], g, 0);
    // visible page is 100 wide, 200 tall: along-text now runs along visible x
    expect(w2.box.x).toBeGreaterThan(w1.box.x);
    expect(w1.box.w).toBeCloseTo(20);
    expect(w1.box.h).toBeCloseTo(12.5);
    for (const w of [w1, w2]) {
      expect(w.box.x).toBeGreaterThanOrEqual(0);
      expect(w.box.x + w.box.w).toBeLessThanOrEqual(100);
    }
  });
  it("exact boxes for each page rotation", () => {
    const expected: Record<number, [number, number, number, number]> = {
      0: [50, 17.5, 20, 12.5],
      90: [17.5, 130, 12.5, 20],
      180: [130, 70, 20, 12.5],
      270: [70, 50, 12.5, 20],
    };
    for (const rotate of [0, 90, 180, 270]) {
      const [w] = wordsFromRuns([run("ab", 50, 20, 20)], { view: [0, 0, 200, 100], rotate }, 0);
      const [x, y, bw, bh] = expected[rotate];
      expect([w.box.x, w.box.y, w.box.w, w.box.h].map((n) => Math.round(n * 1000) / 1000)).toEqual([x, y, bw, bh]);
    }
  });
  it("merges a word split across runs into one word with the union box", () => {
    const ws = wordsFromRuns([run("Hel", 10, 20, 30), run("lo", 40.5, 20, 20)], geo, 0);
    expect(ws.map((w) => w.text)).toEqual(["Hello"]);
    expect(ws[0].box.x).toBeCloseTo(10);
    
    expect(ws[0].box.x + ws[0].box.w).toBeCloseTo(60.5);
  });
  it("keeps two runs separated by a wide gap (no space character) as two words", () => {
    const ws = wordsFromRuns([run("ab", 10, 20, 20), run("cd", 33, 20, 20)], geo, 0); // gap 3 = 0.3 em
    expect(ws.map((w) => w.text)).toEqual(["ab", "cd"]);
  });
  it("does not merge across lines or baselines", () => {
    expect(wordsFromRuns([run("ab", 10, 20, 20, { hasEOL: true }), run("cd", 30, 20, 20)], geo, 0)).toHaveLength(2);
    expect(wordsFromRuns([run("ab", 10, 20, 20), run("cd", 30, 40, 20)], geo, 0)).toHaveLength(2);
  });
  it("offsets by the CropBox origin", () => {
    const g = { view: [100, 100, 300, 200] as [number, number, number, number], rotate: 0 };
    const [w] = wordsFromRuns([run("a", 110, 120, 10)], g, 0);
    expect(w.box.x).toBeCloseTo(10);
    expect(w.box.y).toBeCloseTo(17.5);
  });
});

describe("extractWords on fixtures", () => {
  it("compare-a: words per page in reading order", async () => {
    const pages = await extractWords(await load("compare-a.pdf"));
    expect(pages).toHaveLength(2);
    expect(texts(pages[0]).slice(0, 5)).toEqual(["Compare", "Fixture", "The", "quick", "brown"]);
    expect(texts(pages[0])).toContain("removed");
    expect(texts(pages[1]).join(" ")).toBe("Second page keeps the same words in both files.");
    expect(pages[0].every((w) => w.page === 0) && pages[1].every((w) => w.page === 1)).toBe(true);
  });
  it("compare-b: one extra page, replaced and added words", async () => {
    const pages = await extractWords(await load("compare-b.pdf"));
    expect(pages).toHaveLength(3);
    expect(texts(pages[0])).toContain("swift");
    expect(texts(pages[0])).not.toContain("quick");
    expect(texts(pages[0])).toContain("added");
    expect(texts(pages[1]).join(" ")).toBe("Second page keeps the same words in both files. Paragraph two moves to the bottom later.");
    expect(texts(pages[2]).join(" ")).toBe("Third page exists only in the modified copy.");
  });
  it("boxes are inside the page and ordered", async () => {
    const pages = await extractWords(await load("compare-a.pdf"));
    for (const words of pages) {
      for (const w of words) {
        expect(w.box.x).toBeGreaterThanOrEqual(0);
        expect(w.box.y).toBeGreaterThanOrEqual(0);
        expect(w.box.x + w.box.w).toBeLessThanOrEqual(612);
        expect(w.box.y + w.box.h).toBeLessThanOrEqual(792);
        expect(w.box.w).toBeGreaterThan(0);
        expect(w.box.h).toBeGreaterThan(0);
      }
    }
    const [compare, fixture, the] = pages[0];
    expect(fixture.box.x).toBeGreaterThan(compare.box.x + compare.box.w - 1);
    expect(the.box.y).toBeLessThan(compare.box.y); // next line is lower on the page
  });
  it("scan page gives an empty array, page slot kept", async () => {
    expect(await extractWords(await load("compare-scan.pdf"))).toEqual([[]]);
  });
  it("rotated pages keep boxes inside the visible page", async () => {
    const pages = await extractWords(await load("rotated.pdf"));
    expect(pages).toHaveLength(4);
    pages.forEach((words, i) => {
      expect(texts(words)).toEqual([`R${i * 90}`]);
      const [w] = words;
      const [vw, vh] = i % 2 === 1 ? [792, 612] : [612, 792];
      expect(w.box.x).toBeGreaterThanOrEqual(0);
      expect(w.box.y).toBeGreaterThanOrEqual(0);
      expect(w.box.x + w.box.w).toBeLessThanOrEqual(vw);
      expect(w.box.y + w.box.h).toBeLessThanOrEqual(vh);
    });
  });
  it("reports progress", async () => {
    const seen: number[] = [];
    await extractWords(await load("compare-b.pdf"), (done) => seen.push(done));
    expect(seen).toEqual([1, 2, 3]);
  });
});
