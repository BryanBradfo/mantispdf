import { describe, expect, it } from "vitest";
import { MAX_OCR_PIXELS, OCR_DPI, encodePgm, ocrRenderSize, rgbaToGray } from "./render";

describe("OCR render size", () => {
  it("renders at 300 dpi", () => {
    expect(OCR_DPI).toBe(300);
    expect(ocrRenderSize(612, 792)).toEqual({ width: 2550, height: 3300, dpi: 300 });
  });

  it("lowers the dpi so huge pages stay under 25 Mpx", () => {
    const s = ocrRenderSize(2384, 3370); // A0
    expect(s.width * s.height).toBeLessThanOrEqual(MAX_OCR_PIXELS);
    expect(s.dpi).toBeLessThan(300);
    expect(s.width * s.height).toBeGreaterThan(MAX_OCR_PIXELS * 0.99);
    expect(s.width).toBe(Math.floor((2384 * s.dpi) / 72));
  });

  it("keeps at least one pixel per side", () => {
    expect(ocrRenderSize(0.01, 0.01)).toEqual({ width: 1, height: 1, dpi: 300 });
  });
});

describe("grayscale", () => {
  it("uses Rec. 601 luma, transparent pixels as white", () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128]);
    expect([...rgbaToGray(rgba)]).toEqual([255, 0, 76, 255, 127]);
  });
});

describe("PGM encoding", () => {
  it("writes a binary P5 header and the gray bytes", () => {
    const pgm = encodePgm(new Uint8Array([0, 128, 255, 7, 8, 9]), 3, 2);
    const header = "P5\n3 2\n255\n";
    expect(new TextDecoder().decode(pgm.subarray(0, header.length))).toBe(header);
    expect([...pgm.subarray(header.length)]).toEqual([0, 128, 255, 7, 8, 9]);
  });

  it("refuses a buffer of the wrong size", () => {
    expect(() => encodePgm(new Uint8Array(5), 3, 2)).toThrow();
  });
});
