import { describe, expect, it } from "vitest";
import { buildCropJob, describeCrop, fitCropToPage, moveCropRect, resizeCropRect, type CropChoice } from "./cropBox";
import type { Rect } from "./geometryJob";

const letter: [number, number] = [612, 792];

describe("fitCropToPage", () => {
  it("intersects the box with the page", () => {
    expect(fitCropToPage([500, 700, 300, 300], letter)).toEqual([500, 700, 112, 92]);
  });

  it("falls back to the default box when almost nothing is left on the page", () => {
    expect(fitCropToPage([605, 0, 100, 100], letter)).toEqual([612 * 0.05, 792 * 0.05, 612 * 0.9, 792 * 0.9]);
  });
});

describe("moveCropRect", () => {
  it("moves and keeps the box on the page", () => {
    expect(moveCropRect([10, 10, 100, 100], 5, -3, letter)).toEqual([15, 7, 100, 100]);
    expect(moveCropRect([10, 10, 100, 100], -50, 1000, letter)).toEqual([0, 692, 100, 100]);
  });
});

describe("resizeCropRect", () => {
  const r: Rect = [100, 100, 200, 300];

  it("moves only the edges of the dragged handle", () => {
    expect(resizeCropRect(r, "e", 10, 99, letter)).toEqual([100, 100, 210, 300]);
    expect(resizeCropRect(r, "n", 99, 10, letter)).toEqual([100, 100, 200, 310]);
    expect(resizeCropRect(r, "sw", -10, -20, letter)).toEqual([90, 80, 210, 320]);
    expect(resizeCropRect(r, "se", 10, -20, letter)).toEqual([100, 80, 210, 320]);
  });

  it("stops at the page edges", () => {
    expect(resizeCropRect(r, "nw", -500, 1000, letter)).toEqual([0, 100, 300, 692]);
  });

  it("never goes under the minimum size, even when dragged past the opposite edge", () => {
    expect(resizeCropRect(r, "w", 1000, 0, letter, 18)).toEqual([282, 100, 18, 300]);
    expect(resizeCropRect(r, "s", 0, 1000, letter, 18)).toEqual([100, 382, 200, 18]);
  });
});

describe("describeCrop", () => {
  it("speaks size and distance from the top-left", () => {
    expect(describeCrop([10, 20, 300, 400], letter)).toBe("Crop area 300 by 400 pt, 10 pt from the left, 372 pt from the top.");
  });
});

describe("buildCropJob", () => {
  const base: CropChoice = {
    scope: "this",
    page: 3,
    rect: [1, 2, 3, 4],
    range: [1, 2],
    total: 5,
    perPage: null,
    permanent: false,
  };

  it("crops the shown page for scope this", () => {
    expect(buildCropJob(base)).toEqual({ pages: [3], rect: [1, 2, 3, 4], permanent: false });
  });

  it("crops every page for scope all, or a range covering everything", () => {
    expect(buildCropJob({ ...base, scope: "all", permanent: true })).toEqual({ pages: "all", rect: [1, 2, 3, 4], permanent: true });
    expect(buildCropJob({ ...base, scope: "range", range: [1, 2, 3, 4, 5] }).pages).toBe("all");
  });

  it("crops the listed pages for scope range", () => {
    expect(buildCropJob({ ...base, scope: "range" }).pages).toEqual([1, 2]);
  });

  it("sends one sorted entry per page and no shared rect for detected boxes", () => {
    const perPage = new Map<number, Rect>([[2, [5, 5, 50, 50]], [1, [0, 0, 10, 10]]]);
    expect(buildCropJob({ ...base, perPage })).toEqual({
      pages: "all",
      perPage: [
        { page: 1, rect: [0, 0, 10, 10] },
        { page: 2, rect: [5, 5, 50, 50] },
      ],
      permanent: false,
    });
  });
});
