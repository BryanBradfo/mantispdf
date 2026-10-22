import { describe, expect, it } from "vitest";
import type { RecognizedWord } from "./engine";
import { LOW_QUALITY, alreadyOcrLine as alreadyOcrLineT, failedLine as failedLineT, fromPipeline, loadingLabel as loadingLabelT, pageTextFromItems, skippedLine as skippedLineT, summaryHeadline as summaryHeadlineT, wholeDocumentText, MAX_WORDS_PER_PAGE, MAX_WORDS_TOTAL, estimateRemainingMs, formatEta as formatEtaT, summarize, toggleLanguage, wordLimitProblem as wordLimitProblemT, wordsToWire } from "./run";
import { tFor } from "../../i18n/testUtils";

const tEn = tFor("ocr");
const SKIP_HINT = tEn("skipHint");
const alreadyOcrLine = (pages: readonly number[]) => alreadyOcrLineT(pages, tEn);
const failedLine = (pages: readonly number[]) => failedLineT(pages, tEn);
const loadingLabel = (p: Parameters<typeof loadingLabelT>[0]) => loadingLabelT(p, tEn);
const skippedLine = (pages: readonly number[]) => skippedLineT(pages, tEn);
const summaryHeadline = (s: Parameters<typeof summaryHeadlineT>[0]) => summaryHeadlineT(s, tEn);
const formatEta = (ms: number | null) => formatEtaT(ms, tEn);
const wordLimitProblem = (pages: Parameters<typeof wordLimitProblemT>[0]) => wordLimitProblemT(pages, tEn);

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

describe("word limits before download", () => {
  // Sparse arrays: only the length matters.
  const page = (n: number, words: number) => ({ page: n, words: { length: words } as unknown as never[] });

  it("mirrors the engine's limits", () => {
    expect(MAX_WORDS_PER_PAGE).toBe(200_000);
    expect(MAX_WORDS_TOTAL).toBe(2_000_000);
  });

  it("accepts what the engine accepts", () => {
    expect(wordLimitProblem([page(1, 200_000), page(2, 10)])).toBeNull();
    expect(wordLimitProblem(Array.from({ length: 10 }, (_, i) => page(i + 1, 200_000)))).toBeNull();
  });

  it("names the page over the per-page limit", () => {
    expect(wordLimitProblem([page(1, 5), page(7, 200_001)])).toBe(
      "Page 7 has too many recognised words (more than 200000) to add a text layer. Download the text instead.",
    );
  });

  it("refuses more words than the job allows in all", () => {
    const pages = Array.from({ length: 11 }, (_, i) => page(i + 1, 190_000));
    expect(wordLimitProblem(pages)).toBe(
      "Too many recognised words in all (more than 2000000) to add a text layer. Split the PDF, or download the text instead.",
    );
  });
});

describe("summary headline", () => {
  it("counts pages with text found and their words", () => {
    const s = summarize([
      { page: 1, skipped: false, confidence: 90, words: 1 },
      { page: 2, skipped: false, confidence: 0, words: 0 },
      { page: 3, skipped: true },
    ]);
    expect(summaryHeadline(s)).toBe("Text recognised on 1 page (1 word).");
    expect(summaryHeadline(summarize([{ page: 1, skipped: false, confidence: 90, words: 3 }, { page: 2, skipped: false, confidence: 80, words: 4 }]))).toBe(
      "Text recognised on 2 pages (7 words).",
    );
  });

  it("says so when every page was skipped", () => {
    expect(summaryHeadline(summarize([{ page: 1, skipped: true }, { page: 2, skipped: true }]))).toBe(
      `All pages already contain text. Nothing to recognise. ${SKIP_HINT}`,
    );
  });
});

describe("skip messages", () => {
  it("tell how to recognise skipped pages anyway", () => {
    expect(SKIP_HINT).toBe("Turn off 'Skip pages that already contain text' to recognise them anyway.");
    expect(skippedLine([3])).toBe(`Skipped (already had text): page 3. ${SKIP_HINT}`);
    expect(skippedLine([1, 2])).toBe(`Skipped (already had text): pages 1, 2. ${SKIP_HINT}`);
  });
});

describe("engine start label", () => {
  it("shows the language data download as a percentage", () => {
    expect(loadingLabel({ status: "loading language traineddata", progress: 0.42 })).toBe("Loading language data 42%");
    expect(loadingLabel({ status: "loading language traineddata", progress: 1 })).toBe("Loading language data 100%");
    expect(loadingLabel({ status: "initializing api", progress: 0.5 })).toBe("Starting the OCR engine…");
    expect(loadingLabel(null)).toBe("Starting the OCR engine…");
  });
});

describe("text of the whole document", () => {
  it("reads a page's pdf.js text, a line break after each end of line", () => {
    expect(
      pageTextFromItems([
        { str: "Hello", hasEOL: false },
        { str: " world", hasEOL: true },
        { type: "beginMarkedContent" },
        { str: "next line", hasEOL: false },
      ]),
    ).toBe("Hello world\nnext line");
  });

  it("merges recognised and skipped pages in page order", () => {
    expect(
      wholeDocumentText(
        [
          { page: 3, text: "ocr three" },
          { page: 1, text: "ocr one" },
        ],
        [{ page: 2, text: "had text" }],
      ),
    ).toEqual([
      { page: 1, text: "ocr one" },
      { page: 2, text: "had text" },
      { page: 3, text: "ocr three" },
    ]);
  });
});

describe("pipeline result", () => {
  const w = { text: "a", x: 0, y: 0, w: 1, h: 1, baseline: null, spaceAfter: false };
  const pages = [
    { page: 1, skipped: true as const, text: "had text" },
    { page: 2, skipped: false as const, failed: true as const, reason: "boom" },
    { page: 3, skipped: false as const, failed: false as const, confidence: 88, words: [w, w], text: "two words" },
    { page: 4, skipped: false as const, failed: false as const, confidence: 0, words: [], text: "" },
  ];

  it("splits into outcomes, the text layer, texts and failed pages", () => {
    const r = fromPipeline(pages);
    expect(r.outcomes).toEqual([
      { page: 1, skipped: true },
      { page: 3, skipped: false, confidence: 88, words: 2 },
      { page: 4, skipped: false, confidence: 0, words: 0 },
    ]);
    expect(r.layer).toEqual([{ page: 3, words: [w, w] }]);
    expect(r.texts).toEqual([
      { page: 3, text: "two words" },
      { page: 4, text: "" },
    ]);
    expect(r.skippedTexts).toEqual([{ page: 1, text: "had text" }]);
    expect(r.failed).toEqual([2]);
  });

  it("words the failed and already-OCR'd pages", () => {
    expect(failedLine([5])).toBe("Could not read: page 5.");
    expect(failedLine([2, 9])).toBe("Could not read: pages 2, 9.");
    expect(alreadyOcrLine([3])).toBe("Page 3 already had an OCR layer and was left as it was.");
    expect(alreadyOcrLine([3, 4])).toBe("Pages 3, 4 already had an OCR layer and were left as they were.");
  });
});

describe("OCR texts in French", () => {
  const t = tFor("ocr", "fr");
  it("reads in French", () => {
    expect(summaryHeadlineT(summarize([{ page: 1, skipped: false, confidence: 90, words: 7 }]), t)).toBe(
      "Texte reconnu sur 1\u00a0page (7\u00a0mots).",
    );
    expect(formatEtaT(125000, t)).toBe("environ 2\u00a0min 5\u00a0s restantes");
    expect(loadingLabelT({ status: "loading language traineddata", progress: 0.42 }, t)).toBe(
      "Chargement des données de langue 42\u00a0%",
    );
    expect(failedLineT([2, 9], t)).toBe("Lecture impossible\u00a0: pages 2, 9.");
  });
});
