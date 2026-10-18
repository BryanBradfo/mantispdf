import { describe, expect, it } from "vitest";
import { RASTER_DPI, rasterSize, rectToPixels } from "./raster";

describe("raster helper geometry", () => {
  it("sizes the raster to the visible box at the dpi", () => {
    expect(RASTER_DPI).toBe(200);
    expect(rasterSize(612, 792, 200)).toEqual([1700, 2200]);
    expect(rasterSize(595.28, 841.89, 200)).toEqual([1654, 2339]);
  });

  it("maps visible rects to pixel rects from the top, rounding outwards", () => {
    // 72 dpi: 1 px per point; page 792 pt tall.
    expect(rectToPixels([10.5, 20, 5, 10], 1, 792)).toEqual([10, 762, 6, 10]);
    expect(rectToPixels([0, 0, 612, 792], 200 / 72, 2200)).toEqual([0, 0, 1700, 2200]);
  });
});
