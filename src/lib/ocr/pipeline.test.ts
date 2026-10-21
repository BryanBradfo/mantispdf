import { describe, expect, it } from "vitest";
import { OCR_CANCELLED, OCR_ENGINE_STOPPED, type RecognizedPage } from "./engine";
import { runPipeline, type PipelinePage, type PipelineSource } from "./pipeline";
import type { OcrPageImage } from "./render";

const SIZE: [number, number] = [612, 792];
const image = (page: number): OcrPageImage => ({ pgm: new Uint8Array([page]), width: 2550, height: 3300, dpi: 300 });
const recognised = (text: string): RecognizedPage => ({
  text,
  confidence: 90,
  words: [{ text, bbox: { x0: 300, y0: 400, x1: 700, y1: 500 }, baseline: 490, confidence: 90, lineEnd: true }],
});
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A document of `count` pages; `withText` pages have a text layer of their own. */
function source(count: number, withText: number[] = [], log: string[] = [], fail: { render?: number[] } = {}): PipelineSource {
  return {
    pageCount: count,
    pageSize: () => SIZE,
    textItems: async (n) => {
      log.push(`text ${n}`);
      return withText.includes(n) ? [{ str: `Real text of page ${n} is long enough`, hasEOL: false }] : [];
    },
    render: async (n) => {
      log.push(`render ${n}`);
      if (fail.render?.includes(n)) throw new Error(`cannot render page ${n}`);
      return image(n);
    },
  };
}

/** Recognises page images as "p<n>"; `slow` pages wait for `release`. */
function recogniser(opts: { slow?: number[]; fail?: Record<number, Error> } = {}) {
  const releases: (() => void)[] = [];
  return {
    releases,
    recognize: async (img: Uint8Array, onProgress?: (p: number) => void) => {
      const n = img[0];
      onProgress?.(0.5);
      if (opts.slow?.includes(n)) await new Promise<void>((r) => releases.push(r));
      if (opts.fail?.[n]) throw opts.fail[n];
      return recognised(`p${n}`);
    },
  };
}

const pagesOf = (results: PipelinePage[]) =>
  results.map((r) => (r.skipped ? `${r.page}:skipped` : r.failed ? `${r.page}:failed` : `${r.page}:${r.text}`));

describe("OCR pipeline", () => {
  it("returns every page in page order, whatever order the lanes finish in", async () => {
    const rec = recogniser({ slow: [1] });
    const done: number[] = [];
    const run = runPipeline(source(4), rec, { lanes: 2, skipText: false, onPageDone: (r) => done.push(r.page) });
    await tick();
    await tick();
    await tick();
    rec.releases.forEach((r) => r());
    const results = await run;
    expect(pagesOf(results)).toEqual(["1:p1", "2:p2", "3:p3", "4:p4"]);
    expect(done[done.length - 1]).toBe(1);
    const first = results[0];
    expect(first.skipped || first.failed ? null : first.words[0]).toMatchObject({ text: "p1", x: 72, w: 96, spaceAfter: false });
  });

  it("skips pages with text before rendering them, keeping their text", async () => {
    const log: string[] = [];
    const results = await runPipeline(source(4, [1, 3], log), recogniser(), { lanes: 1, skipText: true });
    expect(pagesOf(results)).toEqual(["1:skipped", "2:p2", "3:skipped", "4:p4"]);
    expect(results[0]).toEqual({ page: 1, skipped: true, text: "Real text of page 1 is long enough" });
    expect(log).toEqual(["text 1", "text 2", "render 2", "text 3", "text 4", "render 4"]);
  });

  it("reads pages with text too when not skipping", async () => {
    const log: string[] = [];
    const results = await runPipeline(source(2, [1], log), recogniser(), { lanes: 1, skipText: false });
    expect(pagesOf(results)).toEqual(["1:p1", "2:p2"]);
    expect(log).toEqual(["render 1", "render 2"]);
  });

  it("records a page that fails and goes on", async () => {
    const results = await runPipeline(source(4, [], [], { render: [2] }), recogniser({ fail: { 3: new Error("RuntimeError: unreachable") } }), {
      lanes: 2,
      skipText: false,
    });
    expect(pagesOf(results)).toEqual(["1:p1", "2:failed", "3:failed", "4:p4"]);
    expect(results[1]).toEqual({ page: 2, skipped: false, failed: true, reason: "cannot render page 2" });
    expect(results[2]).toEqual({ page: 3, skipped: false, failed: true, reason: "RuntimeError: unreachable" });
  });

  it("stops at a cancel: no page is started after it", async () => {
    let cancelled = false;
    const log: string[] = [];
    const run = runPipeline(source(5, [], log), recogniser(), {
      lanes: 1,
      skipText: false,
      isCancelled: () => cancelled,
      onPageDone: (r) => {
        if (r.page === 2) cancelled = true;
      },
    });
    await expect(run).rejects.toThrow(OCR_CANCELLED);
    expect(log).toEqual(["render 1", "render 2"]);
  });

  it("is ended by the engine's cancel or stop, not by a page failure", async () => {
    for (const fatal of [OCR_CANCELLED, OCR_ENGINE_STOPPED]) {
      const log: string[] = [];
      const run = runPipeline(source(6, [], log), recogniser({ fail: { 2: new Error(fatal) } }), { lanes: 1, skipText: false });
      await expect(run).rejects.toThrow(fatal);
      expect(log).toEqual(["render 1", "render 2"]);
    }
  });

  it("reports each page's progress by page number", async () => {
    const progress: [number, number][] = [];
    const started: number[] = [];
    await runPipeline(source(2), recogniser(), {
      lanes: 2,
      skipText: false,
      onPageStart: (n) => started.push(n),
      onPageProgress: (n, f) => progress.push([n, f]),
    });
    expect(started.sort()).toEqual([1, 2]);
    expect(progress.sort()).toEqual([
      [1, 0.5],
      [2, 0.5],
    ]);
  });
});
