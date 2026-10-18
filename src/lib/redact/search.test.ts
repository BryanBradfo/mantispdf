import { describe, expect, it } from "vitest";
import { findMatches, type PageGeometry, type TextRun } from "./search";

const upright: PageGeometry = { view: [0, 0, 612, 792], rotate: 0 };
const run = (str: string, x: number, width: number, y = 700, size = 10, hasEOL = false): TextRun => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width,
  hasEOL,
});

/** Split items by character count (not the default). */
const split = { wholeItem: false };

/** Rects rounded to 1e-9 for comparison. */
const round = (rects: [number, number, number, number][]) => rects.map((r) => r.map((v) => Math.round(v * 1e9) / 1e9));

describe("text search geometry", () => {
  it("splits the item width by characters, pads 1 pt, uses 0.25 em descent and 1 em ascent", () => {
    const rects = findMatches([run("Hello World", 100, 55)], upright, "world", split).map((m) => m.rect);
    // x 100 + 55 * 6/11 = 130 .. 155, padded; y 700 - 2.5 .. 710.
    expect(round(rects)).toEqual([[129, 697.5, 27, 12.5]]);
  });

  it("is case-insensitive and finds every occurrence", () => {
    const rects = findMatches([run("aXa xa", 0, 60)], upright, "XA");
    expect(rects.length).toBe(2);
  });

  it("whole-word matching skips matches inside words", () => {
    const items = [run("password pass", 0, 130)];
    expect(findMatches(items, upright, "pass").length).toBe(2);
    expect(findMatches(items, upright, "pass", { wholeWord: true }).length).toBe(1);
  });

  it("matches across items and marks each part", () => {
    const items = [run("Hel", 100, 15), run("lo there", 115, 40)];
    const matches = findMatches(items, upright, "hello", split);
    expect(matches.length).toBe(1);
    expect(round(matches[0].rects)).toEqual([
      [99, 697.5, 17, 12.5],
      [114, 697.5, 12, 12.5],
    ]);
  });

  it("a line break between items counts as a space", () => {
    const items = [run("John", 0, 20, 700, 10, true), run("Smith", 0, 25, 680)];
    expect(findMatches(items, upright, "john smith").length).toBe(1);
    expect(findMatches(items, upright, "johnsmith").length).toBe(0);
  });

  it("marks the whole item by default", () => {
    const rects = findMatches([run("Hello World", 100, 55)], upright, "world").map((m) => m.rect);
    expect(round(rects)).toEqual([[99, 697.5, 57, 12.5]]);
  });

  it("maps to visible space on cropped and rotated pages", () => {
    const cropped: PageGeometry = { view: [10, 20, 600, 780], rotate: 0 };
    expect(round(findMatches([run("Hello World", 100, 55)], cropped, "world", split).map((m) => m.rect))).toEqual([[119, 677.5, 27, 12.5]]);
    // Rotate 90 on [0 0 612 792]: visible (vx, vy) = (y, 612 - x).
    const turned: PageGeometry = { view: [0, 0, 612, 792], rotate: 90 };
    expect(round(findMatches([run("Hello World", 100, 55)], turned, "world", split).map((m) => m.rect))).toEqual([[697.5, 456, 12.5, 27]]);
  });

  it("handles rotated text runs", () => {
    // Text going up the page at x = 300.
    const up: TextRun = { str: "ABCD", transform: [0, 10, -10, 0, 300, 100], width: 40, hasEOL: false };
    const rects = findMatches([up], upright, "bc", split).map((m) => m.rect);
    // Along y: 100 + 10 .. 100 + 30, padded; across x: 300 - 10 (ascent) .. 300 + 2.5 (descent).
    expect(round(rects)).toEqual([[290, 109, 12.5, 22]]);
  });

  it("an empty query finds nothing", () => {
    expect(findMatches([run("abc", 0, 30)], upright, "")).toEqual([]);
  });
});
