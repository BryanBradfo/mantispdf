import { describe, expect, it } from "vitest";
import { GRID_MAX_SIDE, GRID_PIXELS, MAX_RENDER_PX, overlayEntries, pairGrid, overlayRenderWidth, percentParts, visibleEntries, type PageResult } from "./overlay";

describe("overlayEntries", () => {
  it("pairs pages by index and lists the extra pages of the longer document", () => {
    expect(overlayEntries(2, 3)).toEqual([
      { page: 1, kind: "pair" },
      { page: 2, kind: "pair" },
      { page: 3, kind: "only-b" },
    ]);
    expect(overlayEntries(2, 1)).toEqual([
      { page: 1, kind: "pair" },
      { page: 2, kind: "only-a" },
    ]);
    expect(overlayEntries(0, 0)).toEqual([]);
  });
});

describe("visibleEntries", () => {
  const entries = overlayEntries(3, 4);
  const results = new Map<number, PageResult>([
    [1, { status: "done", ratio: 0 }],
    [2, { status: "done", ratio: 0.02 }],
  ]);

  it("keeps every page without the filter", () => {
    expect(visibleEntries(entries, results, false)).toHaveLength(4);
  });

  it("keeps pages with differences and pages in one document only with the filter", () => {
    expect(visibleEntries(entries, results, true).map((e) => e.page)).toEqual([2, 4]);
  });

  it("keeps a page that failed (it may differ) and drops pages not scanned yet", () => {
    const r = new Map<number, PageResult>([[3, { status: "error" }]]);
    expect(visibleEntries(entries, r, true).map((e) => e.page)).toEqual([3, 4]);
  });
});

describe("overlayRenderWidth", () => {
  it("renders at the displayed width times the pixel ratio, capped", () => {
    expect(overlayRenderWidth(500, 1)).toBe(500);
    expect(overlayRenderWidth(500, 2)).toBe(1000);
    expect(overlayRenderWidth(1400, 2)).toBe(MAX_RENDER_PX);
    expect(MAX_RENDER_PX).toBe(2000);
  });

  it("rounds up to a 100 px step so small resizes reuse the renders", () => {
    expect(overlayRenderWidth(431, 1)).toBe(500);
    expect(overlayRenderWidth(0, 1)).toBe(100);
  });
});

describe("percentParts", () => {
  it("says zero for no change and floors tiny changes at 0.1 %", () => {
    expect(percentParts(0)).toEqual({ value: 0, below: false });
    expect(percentParts(0.0004)).toEqual({ value: 0.001, below: true });
    expect(percentParts(0.034)).toEqual({ value: 0.034, below: false });
  });

  it("never rounds a real change up to 100 %", () => {
    expect(percentParts(0.9996)).toEqual({ value: 0.999, below: false });
    expect(percentParts(1)).toEqual({ value: 1, below: false });
  });
});

describe("pairGrid", () => {
  it("renders a pair on a fixed pixel budget, whatever the screen", () => {
    const g = pairGrid([612, 792], [612, 792]);
    expect(GRID_PIXELS).toBe(1_500_000);
    expect(g.widthA).toBe(g.widthB);
    expect(g.widthA * Math.round(792 * (g.widthA / 612))).toBeGreaterThan(GRID_PIXELS * 0.99);
    expect(g.widthA * Math.round(792 * (g.widthA / 612))).toBeLessThan(GRID_PIXELS * 1.01);
    // The same sizes always give the same grid (no viewport, no devicePixelRatio).
    expect(pairGrid([612, 792], [612, 792])).toEqual(g);
  });

  it("fits the modified page to the original's width", () => {
    const g = pairGrid([612, 792], [1224, 1584]);
    expect(g.widthB).toBe(g.widthA);
    expect(g.scaleB).toBeCloseTo(g.scaleA / 2);
  });

  it("keeps a landscape page landscape and bounds posters", () => {
    const land = pairGrid([792, 612], [792, 612]);
    expect(land.widthA).toBeGreaterThan(Math.round(612 * land.scaleA));
    const strip = pairGrid([100, 20000], [100, 20000]);
    expect(20000 * strip.scaleA).toBeLessThanOrEqual(GRID_MAX_SIDE + 0.5);
    // A short original against a very tall modified page: the tall page is scaled down to fit too.
    const tall = pairGrid([612, 792], [612, 50000]);
    expect(50000 * tall.scaleB).toBeLessThanOrEqual(GRID_MAX_SIDE + 0.5);
  });

  it("falls back to Letter for an unknown size", () => {
    expect(pairGrid([0, 0], [612, 792])).toEqual(pairGrid([612, 792], [612, 792]));
  });
});
