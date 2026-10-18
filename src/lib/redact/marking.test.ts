import { describe, expect, it } from "vitest";
import { entryLabel, numberEntries, repeatTargets, selectedMarks } from "./marking";
import type { MarkInput } from "./model";

const hit = (page: number, x: number): MarkInput => ({ kind: "search", page, rect: [x, 10, 20, 8], query: "secret" });

describe("search results review", () => {
  it("numbers the found areas per page, in order", () => {
    const entries = numberEntries([hit(2, 0), hit(1, 0), hit(2, 50), hit(2, 90)]);
    expect(entries.map((e) => [e.id, e.page, e.index])).toEqual([
      [0, 2, 1],
      [1, 1, 1],
      [2, 2, 2],
      [3, 2, 3],
    ]);
    expect(entryLabel(entries[2])).toBe("Page 2, match 2");
  });

  it("marks only the checked entries", () => {
    const found = [hit(1, 0), hit(1, 50), hit(3, 0)];
    const entries = numberEntries(found);
    expect(selectedMarks(entries, new Set([0, 2]))).toEqual([found[0], found[2]]);
    expect(selectedMarks(entries, new Set())).toEqual([]);
    expect(selectedMarks(entries, new Set(entries.map((e) => e.id)))).toEqual(found);
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
