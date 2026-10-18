import { describe, expect, it } from "vitest";
import { MAX_RASTER_BYTES, MIN_RASTER_DPI, RASTER_DPI, chooseDpi, rasterBytes, rasterSize, rectToPixels } from "./raster";

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

describe("chooseDpi", () => {
  const letter: [number, number] = [612, 792];

  it("counts 4 bytes per pixel of every page", () => {
    expect(rasterBytes([letter, letter], 200)).toBe(2 * 1700 * 2200 * 4);
  });

  it("uses 200 dpi when every page fits the budget", () => {
    expect(MAX_RASTER_BYTES).toBe(512 * 1024 * 1024);
    expect(chooseDpi([letter])).toBe(RASTER_DPI);
    expect(chooseDpi(Array(35).fill(letter))).toBe(200);
    expect(chooseDpi([])).toBe(200);
  });

  it("lowers the dpi just enough for many pages", () => {
    const pages: [number, number][] = Array(60).fill(letter);
    const dpi = chooseDpi(pages);
    expect(dpi).not.toBeNull();
    expect(dpi).toBeLessThan(200);
    expect(rasterBytes(pages, dpi as number)).toBeLessThanOrEqual(MAX_RASTER_BYTES);
    expect(rasterBytes(pages, (dpi as number) + 1)).toBeGreaterThan(MAX_RASTER_BYTES);
  });

  it("gives up below 100 dpi", () => {
    expect(MIN_RASTER_DPI).toBe(100);
    // A letter page at 100 dpi is 850 x 1100 x 4 = 3.74 MB: 143 fit in 512 MiB, 144 do not.
    expect(chooseDpi(Array(143).fill(letter))).toBe(100);
    expect(chooseDpi(Array(144).fill(letter))).toBeNull();
  });
});

