import { describe, expect, it } from "vitest";
import { entryText, keepFallback, repeatTargets, searchEntries, selectedMarks } from "./marking";
import type { Rect } from "./model";
import type { SearchMatchWire } from "./searchWire";

const match = (page: number, rects: Rect[], text = "secret", before = "the ", after = " code"): SearchMatchWire => ({
  page,
  rects,
  context: { before, text, after },
});

describe("search results review", () => {
  it("keeps one entry per match, a match across lines being one entry with a mark per line", () => {
    const entries = searchEntries(
      [match(1, [[10, 700, 30, 10]]), match(2, [[500, 700, 40, 10], [10, 686, 20, 10]], "secret code")],
      [],
      "secret",
    );
    expect(entries.map((e) => [e.id, e.page, e.marks.length])).toEqual([
      [0, 1, 1],
      [1, 2, 2],
    ]);
    expect(entries[1].marks).toEqual([
      { kind: "search", page: 2, rect: [500, 700, 40, 10], query: "secret" },
      { kind: "search", page: 2, rect: [10, 686, 20, 10], query: "secret" },
    ]);
  });

  it("shows the match in its context, with ellipses where the text goes on", () => {
    const [e] = searchEntries([match(3, [[0, 0, 1, 1]], "Secret", "is ", " here")], [], "secret");
    expect(entryText(e)).toEqual({ page: 3, before: "…is ", text: "Secret", after: " here…" });
    const [bare] = searchEntries([match(1, [[0, 0, 1, 1]], "x", "", "")], [], "x");
    expect(entryText(bare)).toEqual({ page: 1, before: "", text: "x", after: "" });
  });

  it("lists fallback matches (unreadable text) after the engine's, without context", () => {
    const entries = searchEntries([match(1, [[0, 0, 1, 1]])], [{ page: 2, rects: [[5, 5, 10, 10]] }], "secret");
    expect(entries.map((e) => [e.id, e.page, e.context])).toEqual([
      [0, 1, { before: "the ", text: "secret", after: " code" }],
      [1, 2, null],
    ]);
    expect(entryText(entries[1])).toEqual({ page: 2, before: "", text: "unreadable text", after: "" });
  });

  it("marks only the checked entries, every line of each", () => {
    const entries = searchEntries([match(1, [[0, 0, 1, 1], [0, 5, 1, 1]]), match(2, [[1, 1, 1, 1]])], [], "q");
    expect(selectedMarks(entries, new Set([0])).map((m) => m.page)).toEqual([1, 1]);
    expect(selectedMarks(entries, new Set())).toEqual([]);
    expect(selectedMarks(entries, new Set([0, 1]))).toHaveLength(3);
  });
});

describe("fallback filter (fails closed)", () => {
  const unknown: Rect[] = [[100, 100, 50, 20]];

  it("decides per match: one rect meeting unknown text keeps every rect of the match", () => {
    const match: Rect[] = [
      [90, 110, 20, 5], // meets the unknown box
      [300, 90, 40, 10], // elsewhere (the next line of the same match)
    ];
    expect(keepFallback(match, unknown, true)).toBe(true);
    expect(keepFallback([[300, 90, 40, 10]], unknown, true)).toBe(false);
  });

  it("counts edges that touch, and anything within 2 pt, as meeting", () => {
    // Touching the right edge (x = 150).
    expect(keepFallback([[150, 100, 10, 20]], unknown, true)).toBe(true);
    // 1.9 pt to the right of the box: inside the 2 pt tolerance.
    expect(keepFallback([[151.9, 100, 10, 20]], unknown, true)).toBe(true);
    // Exactly 2 pt away still touches the inflated box.
    expect(keepFallback([[152, 100, 10, 20]], unknown, true)).toBe(true);
    // 2.1 pt away does not.
    expect(keepFallback([[152.1, 100, 10, 20]], unknown, true)).toBe(false);
    // Same below the box (y = 100).
    expect(keepFallback([[110, 90, 10, 8]], unknown, true)).toBe(true);
    expect(keepFallback([[110, 80, 10, 7.9]], unknown, true)).toBe(false);
  });

  it("keeps every match on a page whose unknown boxes the engine does not vouch for", () => {
    expect(keepFallback([[400, 400, 10, 10]], unknown, false)).toBe(true);
    expect(keepFallback([[400, 400, 10, 10]], [], false)).toBe(true);
  });

  it("drops matches on a complete page without unknown text", () => {
    expect(keepFallback([[0, 0, 10, 10]], [], true)).toBe(false);
  });
});

describe("repeat an area on other pages", () => {
  const sizes: [number, number][] = [
    [612, 792],
    [612, 792],
    [300, 400],
    [792, 612],
  ];

  it("copies the area to the chosen pages, never its own page twice", () => {
    const { marks, skipped } = repeatTargets([100, 100, 200, 50], 1, [1, 2, 4], sizes);
    expect(marks).toEqual([
      { kind: "area", page: 2, rect: [100, 100, 200, 50] },
      { kind: "area", page: 4, rect: [100, 100, 200, 50] },
    ]);
    expect(skipped).toEqual([]);
  });

  it("skips pages too small to contain it", () => {
    const { marks, skipped } = repeatTargets([100, 500, 200, 100], 1, [2, 3, 4], sizes);
    // Page 3 is 300 x 400 (too narrow and too short); page 4 is 612 tall (500 + 100 fits).
    expect(marks.map((m) => m.page)).toEqual([2, 4]);
    expect(skipped).toEqual([3]);
    expect(repeatTargets([500, 100, 200, 50], 1, [4, 3], sizes).skipped).toEqual([3]);
  });

  it("ignores pages without a size", () => {
    expect(repeatTargets([0, 0, 10, 10], 1, [9], sizes)).toEqual({ marks: [], skipped: [9] });
  });
});
