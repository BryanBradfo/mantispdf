import { describe, expect, it } from "vitest";
import { DIFF_DILATE, DIFF_THRESHOLD, paintMask, pixelDiff, type Pixels } from "./pixelDiff";

/** A white w x h image, opaque. */
function white(w: number, h: number): Pixels {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
}

function set(img: Pixels, x: number, y: number, rgba: [number, number, number, number]) {
  img.data.set(rgba, (y * img.width + x) * 4);
}

/** The mask as rows of "#" (changed) and "." for readable assertions. */
function rows(mask: Uint8Array, w: number, h: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let r = "";
    for (let x = 0; x < w; x++) r += mask[y * w + x] ? "#" : ".";
    out.push(r);
  }
  return out;
}

describe("pixelDiff", () => {
  it("uses the spec constants (threshold 32, 2 px dilation)", () => {
    expect(DIFF_THRESHOLD).toBe(32);
    expect(DIFF_DILATE).toBe(2);
  });

  it("finds nothing between identical images", () => {
    const a = white(20, 10);
    set(a, 3, 4, [0, 0, 0, 255]);
    const b = { ...a, data: a.data.slice() };
    const d = pixelDiff(a, b);
    expect(d.changed).toBe(0);
    expect(d.ratio).toBe(0);
    expect(d.mask.every((v) => v === 0)).toBe(true);
  });

  it("dilates a single changed pixel into a 5 x 5 square", () => {
    const a = white(9, 9);
    const b = white(9, 9);
    set(b, 4, 4, [0, 0, 0, 255]);
    const d = pixelDiff(a, b);
    expect(d.changed).toBe(1);
    expect(d.ratio).toBeCloseTo(1 / 81);
    expect(rows(d.mask, 9, 9)).toEqual([
      ".........",
      ".........",
      "..#####..",
      "..#####..",
      "..#####..",
      "..#####..",
      "..#####..",
      ".........",
      ".........",
    ]);
  });

  it("clips the dilation at the image edges", () => {
    const a = white(4, 3);
    const b = white(4, 3);
    set(b, 0, 0, [0, 0, 0, 255]);
    const d = pixelDiff(a, b);
    expect(rows(d.mask, 4, 3)).toEqual(["###.", "###.", "###."]);
  });

  it("ignores a channel difference of 32 and flags 33 (per channel)", () => {
    const a = white(5, 5);
    const at32 = white(5, 5);
    set(at32, 2, 2, [255 - 32, 255, 255, 255]);
    expect(pixelDiff(a, at32).changed).toBe(0);
    const at33 = white(5, 5);
    set(at33, 2, 2, [255, 255, 255 - 33, 255]);
    expect(pixelDiff(a, at33).changed).toBe(1);
    // Small differences in every channel do not add up.
    const spread = white(5, 5);
    set(spread, 2, 2, [255 - 30, 255 - 30, 255 - 30, 255]);
    expect(pixelDiff(a, spread).changed).toBe(0);
  });

  it("counts every changed pixel once in the ratio (not the dilated mask)", () => {
    const a = white(10, 10);
    const b = white(10, 10);
    for (let x = 0; x < 10; x++) set(b, x, 0, [0, 0, 0, 255]);
    const d = pixelDiff(a, b);
    expect(d.changed).toBe(10);
    expect(d.ratio).toBeCloseTo(0.1);
  });

  it("refuses images of different sizes", () => {
    expect(() => pixelDiff(white(4, 4), white(4, 5))).toThrow(/same size/);
    expect(() => pixelDiff(white(4, 4), white(5, 4))).toThrow(/same size/);
  });

  it("refuses a buffer that does not match its dimensions", () => {
    expect(() => pixelDiff({ width: 4, height: 4, data: new Uint8ClampedArray(10) }, white(4, 4))).toThrow();
  });

  it("handles an empty image", () => {
    const d = pixelDiff(white(0, 0), white(0, 0));
    expect(d.changed).toBe(0);
    expect(d.ratio).toBe(0);
  });
});

describe("paintMask", () => {
  it("paints masked pixels in the given colour and leaves the rest transparent", () => {
    const mask = new Uint8Array([1, 0, 0, 1]);
    const out = paintMask(mask, [198, 40, 40, 140]);
    expect([...out]).toEqual([198, 40, 40, 140, 0, 0, 0, 0, 0, 0, 0, 0, 198, 40, 40, 140]);
  });
});
