import { describe, expect, it } from "vitest";
import { addMarks, initialMarks, togglePage } from "./model";
import { marksToRects, pagesWithMarks, sameRun, takeRun } from "./toJob";

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

describe("run snapshot", () => {
  it("holds the marks and options a redaction runs with", () => {
    const s = addMarks(initialMarks(), [{ kind: "area", page: 1, rect: [0, 0, 5, 5] }]);
    const run = takeRun(s.marks, "white", false);
    expect(run).toEqual({ marks: s.marks, fill: "white", removeMetadata: false });
  });

  it("is the same only for the very same marks and options", () => {
    const s = addMarks(initialMarks(), [{ kind: "area", page: 1, rect: [0, 0, 5, 5] }]);
    const run = takeRun(s.marks, "black", true);
    expect(sameRun(run, takeRun(s.marks, "black", true))).toBe(true);
    expect(sameRun(run, takeRun(s.marks, "white", true))).toBe(false);
    expect(sameRun(run, takeRun(s.marks, "black", false))).toBe(false);
    // Marks are immutable state: any edit makes a new array.
    const edited = addMarks(s, [{ kind: "area", page: 1, rect: [1, 1, 5, 5] }]);
    expect(sameRun(run, takeRun(edited.marks, "black", true))).toBe(false);
    // Equal content in a new array (undo then redo) counts as the same marks.
    expect(sameRun(run, takeRun([...s.marks], "black", true))).toBe(true);
  });
});

