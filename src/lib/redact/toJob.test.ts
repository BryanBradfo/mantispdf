import { describe, expect, it } from "vitest";
import { addMarks, initialMarks, togglePage } from "./model";
import { marksToRects, pagesWithMarks } from "./toJob";

describe("marks to engine rects", () => {
  it("normalizes areas, expands pages to their visible size and keeps page order", () => {
    let s = initialMarks();
    s = addMarks(s, [
      { kind: "area", page: 2, rect: [50, 60, -10, -20] },
      { kind: "search", page: 1, rect: [1, 2, 3, 4], query: "x" },
    ]);
    s = togglePage(s, 1);
    expect(marksToRects(s.marks, [[600, 800], [842, 595]])).toEqual([
      { page: 1, rect: [1, 2, 3, 4] },
      { page: 1, rect: [0, 0, 600, 800] },
      { page: 2, rect: [40, 40, 10, 20] },
    ]);
    expect(pagesWithMarks(s.marks)).toEqual([1, 2]);
  });

  it("skips pages it has no size for", () => {
    const s = togglePage(initialMarks(), 9);
    expect(marksToRects(s.marks, [[600, 800]])).toEqual([]);
  });
});
