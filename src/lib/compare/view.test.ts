import { describe, expect, it } from "vitest";
import { compareDocuments } from "./compare";
import type { Word } from "./types";
import {
  buildAnchors,
  changeTarget,
  countWords,
  highlightMarks,
  mapPosition,
  markBox,
  mergeLineBoxes,
  posFromPx,
  pxFromPos,
  type Size,
} from "./view";

const LETTER: Size = [612, 792];

/** Words on one line of `page`, 10 pt high, laid out left to right from x = 72 (each 30 pt wide, 5 pt apart). */
function line(text: string, page: number, y: number): Word[] {
  return text.split(" ").map((t, i) => ({ text: t, page, box: { x: 72 + i * 35, y, w: 30, h: 10 } }));
}

describe("markBox", () => {
  it("trims a word box to 0.15 em below and 0.85 em above the baseline", () => {
    const m = markBox({ x: 10, y: 96.5, w: 30, h: 17.5 }); // 14 pt type, baseline at 100
    expect(m.x).toBe(10);
    expect(m.w).toBe(30);
    expect(m.y).toBeCloseTo(100 - 0.15 * 14);
    expect(m.y + m.h).toBeCloseTo(100 + 0.85 * 14);
  });
});

describe("mergeLineBoxes", () => {
  it("joins neighbouring words of one line into one box", () => {
    const words = line("a b c", 0, 700);
    expect(mergeLineBoxes(words)).toEqual([{ x: 72, y: 700, w: 100, h: 10 }]);
  });

  it("starts a new box on another line or after a wide gap", () => {
    const words = [...line("a b", 0, 700), ...line("c", 0, 680), { text: "d", page: 0, box: { x: 400, y: 680, w: 20, h: 10 } }];
    expect(mergeLineBoxes(words)).toEqual([
      { x: 72, y: 700, w: 65, h: 10 },
      { x: 72, y: 680, w: 30, h: 10 },
      { x: 400, y: 680, w: 20, h: 10 },
    ]);
  });

  it("is empty for no words", () => {
    expect(mergeLineBoxes([])).toEqual([]);
  });
});

describe("highlightMarks", () => {
  it("puts removed words on the original side and added words on the modified side, by page", () => {
    const a = [line("one two three", 0, 700), line("four", 1, 700)];
    const b = [line("one TWO three", 0, 700), line("four five", 1, 700)];
    const result = compareDocuments(a, b);
    const marks = highlightMarks(result, a, b);
    expect(result.changes.map((c) => c.kind)).toEqual(["changed", "added"]);
    expect(marks.a).toEqual([[{ change: 0, kind: "removed", box: { x: 107, y: 700.8, w: 30, h: 8 } }], []]);
    expect(marks.b).toEqual([
      [{ change: 0, kind: "added", box: { x: 107, y: 700.8, w: 30, h: 8 } }],
      [{ change: 1, kind: "added", box: { x: 107, y: 700.8, w: 30, h: 8 } }],
    ]);
  });

  it("marks the right copy of a repeated word", () => {
    const a = [line("the the the", 0, 700)];
    const b = [line("the the", 0, 700)];
    const result = compareDocuments(a, b);
    const marks = highlightMarks(result, a, b);
    expect(marks.a[0]).toHaveLength(1);
    expect(marks.b[0]).toEqual([]);
    // One "the" is gone; the mark covers exactly one word box.
    expect(marks.a[0][0].box.w).toBe(30);
  });

  it("gives a word split into several tokens one mark", () => {
    const a = [[{ text: "10\u00a0km", page: 0, box: { x: 72, y: 700, w: 40, h: 10 } }]];
    const b: Word[][] = [[]];
    const result = compareDocuments(a, b);
    const marks = highlightMarks(result, a, b);
    expect(marks.a[0]).toEqual([{ change: 0, kind: "removed", box: { x: 72, y: 700.8, w: 40, h: 8 } }]);
  });

  it("keeps a mark off the line above and below (lines set at 18 pt leading, 14 pt type)", () => {
    // Boxes as extraction makes them: 0.25 em below the baseline to 1 em above.
    const at = (text: string, x: number, baseline: number): Word => ({ text, page: 0, box: { x, y: baseline - 3.5, w: 30, h: 17.5 } });
    const a = [[at("above", 72, 718), at("old", 72, 700), at("below", 72, 682)]];
    const b = [[at("above", 72, 718), at("new", 72, 700), at("below", 72, 682)]];
    const marks = highlightMarks(compareDocuments(a, b), a, b);
    for (const m of [...marks.a[0], ...marks.b[0]]) {
      // Under the baseline of the line above, with room for a mark on that line (it stops 0.15 em under it).
      expect(m.box.y + m.box.h).toBeLessThan(718 - 0.15 * 14);
      // Above the cap line of the line below, not covering its glyphs.
      expect(m.box.y).toBeGreaterThan(682 + 0.85 * 14);
      // Still covers its own word from below the baseline to the ascenders.
      expect(m.box.y).toBeLessThan(700);
      expect(m.box.y + m.box.h).toBeGreaterThanOrEqual(700 + 0.85 * 14 - 1e-9);
    }
  });

  it("splits one change across pages", () => {
    const a = [line("x", 0, 100), line("y", 1, 700)];
    const b: Word[][] = [[], []];
    const marks = highlightMarks(compareDocuments(a, b), a, b);
    expect(marks.a.map((p) => p.length)).toEqual([1, 1]);
  });
});

describe("posFromPx / pxFromPos", () => {
  const tops = [0, 110, 220];
  const heights = [100, 100, 50];

  it("turns a pixel offset into page + fraction and back", () => {
    expect(posFromPx(tops, heights, 50)).toBeCloseTo(0.5);
    expect(posFromPx(tops, heights, 135)).toBeCloseTo(1.25);
    expect(pxFromPos(tops, heights, 1.25)).toBeCloseTo(135);
    expect(pxFromPos(tops, heights, 2.5)).toBeCloseTo(245);
  });

  it("clamps: the gap after a page is its end, past the last page is the last page's end", () => {
    expect(posFromPx(tops, heights, 105)).toBeCloseTo(1);
    expect(posFromPx(tops, heights, 9999)).toBeCloseTo(3);
    expect(posFromPx(tops, heights, -10)).toBe(0);
    expect(pxFromPos(tops, heights, 3)).toBeCloseTo(270);
  });

  it("handles no pages", () => {
    expect(posFromPx([], [], 10)).toBe(0);
    expect(pxFromPos([], [], 1)).toBe(0);
  });
});

describe("buildAnchors / mapPosition", () => {
  it("pairs matched words, so text pushed down by an insertion maps to its new place", () => {
    // Modified has two extra lines at the top of page 0: "keep" moves down.
    const a = [[...line("keep", 0, 700), ...line("tail", 0, 100)]];
    const b = [[...line("new", 0, 700), ...line("more", 0, 600), ...line("keep", 0, 500), ...line("tail", 0, 100)]];
    const result = compareDocuments(a, b);
    const anchors = buildAnchors(result, a, b, [LETTER], [LETTER]);
    const keepA = (792 - 705) / 792;
    const keepB = (792 - 505) / 792;
    expect(anchors[0]).toEqual([0, 0]);
    expect(anchors.some(([x, y]) => Math.abs(x - keepA) < 1e-9 && Math.abs(y - keepB) < 1e-9)).toBe(true);
    expect(mapPosition(anchors, keepA)).toBeCloseTo(keepB);
    expect(anchors[anchors.length - 1]).toEqual([1, 1]);
  });

  it("keeps anchors increasing on both sides (a moved paragraph cannot fold the mapping back)", () => {
    const a = [[...line("p1 p1", 0, 700), ...line("p2 p2", 0, 600)]];
    const b = [[...line("p2 p2", 0, 700), ...line("p1 p1", 0, 600)]];
    const anchors = buildAnchors(compareDocuments(a, b), a, b, [LETTER], [LETTER]);
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i][0]).toBeGreaterThan(anchors[i - 1][0]);
      expect(anchors[i][1]).toBeGreaterThan(anchors[i - 1][1]);
    }
  });

  it("interpolates between anchors and maps the other way", () => {
    const anchors: [number, number][] = [[0, 0], [1, 2], [2, 3]];
    expect(mapPosition(anchors, 0.5)).toBeCloseTo(1);
    expect(mapPosition(anchors, 1.5)).toBeCloseTo(2.5);
    expect(mapPosition(anchors, 2.5, "b-to-a")).toBeCloseTo(1.5);
    expect(mapPosition(anchors, 99)).toBe(3);
    expect(mapPosition([], 1)).toBe(1);
  });

  it("ends at each side's page count", () => {
    const a = [line("x", 0, 700)];
    const b = [line("x", 0, 700), line("y", 1, 700)];
    const anchors = buildAnchors(compareDocuments(a, b), a, b, [LETTER], [LETTER, LETTER]);
    expect(anchors[anchors.length - 1]).toEqual([1, 2]);
  });
});

describe("changeTarget", () => {
  const a = [[...line("one two", 0, 700), ...line("three", 0, 600)]];
  const b = [[...line("one two", 0, 700), ...line("added", 0, 650), ...line("three", 0, 600)]];
  const result = compareDocuments(a, b);

  it("points at the first changed word on the side that has it", () => {
    expect(result.changes).toHaveLength(1);
    expect(changeTarget(result, 0, "b", b, [LETTER])).toBeCloseTo((792 - 660) / 792);
  });

  it("points at the insertion place on the other side (the word before it)", () => {
    expect(changeTarget(result, 0, "a", a, [LETTER])).toBeCloseTo((792 - 710) / 792);
  });

  it("is the top of the document when nothing precedes", () => {
    const a2: Word[][] = [line("z", 0, 700)];
    const b2: Word[][] = [[...line("first", 0, 750), ...line("z", 0, 700)]];
    const r = compareDocuments(a2, b2);
    expect(changeTarget(r, 0, "a", a2, [LETTER])).toBeCloseTo((792 - 710) / 792);
  });
});

describe("countWords", () => {
  it("counts the words of every page", () => {
    expect(countWords([line("a b", 0, 1), [], line("c", 2, 1)])).toBe(3);
  });
});
