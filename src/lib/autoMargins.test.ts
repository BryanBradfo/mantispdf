import { describe, expect, it } from "vitest";
import { MAX_DETECT_PX, bboxToVisibleRect, contentBBox, detectScale } from "./autoMargins";

/** A white RGBA image with the listed pixels painted `rgb`. */
function image(width: number, height: number, dark: [number, number][], rgb: [number, number, number] = [0, 0, 0]) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y] of dark) data.set([...rgb, 255], (y * width + x) * 4);
  return data;
}

/** Every pixel of the rectangle [x0, x1) x [y0, y1). */
function block(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push([x, y]);
  return out;
}

describe("contentBBox", () => {
  it("bounds the non-white pixels, exclusive on the right and bottom", () => {
    expect(contentBBox(image(20, 30, block(4, 6, 10, 12)), 20, 30)).toEqual({ x0: 4, y0: 6, x1: 10, y1: 12 });
  });

  it("returns null for a blank page", () => {
    expect(contentBBox(image(20, 30, []), 20, 30)).toBeNull();
  });

  it("ignores a 1 px border all around", () => {
    const frame = [...block(0, 0, 20, 1), ...block(0, 29, 20, 30), ...block(0, 0, 1, 30), ...block(19, 0, 20, 30)];
    expect(contentBBox(image(20, 30, frame), 20, 30)).toBeNull();
    expect(contentBBox(image(20, 30, [...frame, [8, 9]]), 20, 30)).toEqual({ x0: 8, y0: 9, x1: 9, y1: 10 });
  });

  it("counts a pixel as content when any channel is under the threshold", () => {
    expect(contentBBox(image(10, 10, [[5, 5]], [255, 255, 244]), 10, 10)).toEqual({ x0: 5, y0: 5, x1: 6, y1: 6 });
    expect(contentBBox(image(10, 10, [[5, 5]], [245, 245, 245]), 10, 10)).toBeNull();
  });

  it("reaches the border for content touching the edges", () => {
    expect(contentBBox(image(20, 30, block(0, 0, 20, 30)), 20, 30)).toEqual({ x0: 1, y0: 1, x1: 19, y1: 29 });
  });
});

describe("bboxToVisibleRect", () => {
  const page: [number, number] = [612, 792];
  // 50 dpi render of a Letter page.
  const s = 50 / 72;

  it("maps pixels to visible points, flipping y, with 6 pt of padding", () => {
    // Content from (72, 72) to (540, 720) in top-left points.
    const box = { x0: 72 * s, y0: 72 * s, x1: 540 * s, y1: 720 * s };
    const [x, y, w, h] = bboxToVisibleRect(box, [s, s], page);
    expect(x).toBeCloseTo(66);
    expect(y).toBeCloseTo(792 - 720 - 6);
    expect(w).toBeCloseTo(540 - 72 + 12);
    expect(h).toBeCloseTo(720 - 72 + 12);
  });

  it("returns the full page for a blank page", () => {
    expect(bboxToVisibleRect(null, [s, s], page)).toEqual([0, 0, 612, 792]);
  });

  it("clamps padding to the page, so content touching the edges gives the full page", () => {
    const w = Math.ceil(612 * s);
    const h = Math.ceil(792 * s);
    const box = contentBBox(image(w, h, block(0, 0, w, h)), w, h);
    const [x, y, rw, rh] = bboxToVisibleRect(box, [s, s], page);
    expect([x, y]).toEqual([0, 0]);
    expect(rw).toBeCloseTo(612);
    expect(rh).toBeCloseTo(792);
  });

  it("works on a landscape (rotated) page", () => {
    const land: [number, number] = [792, 612];
    const box = { x0: 100 * s, y0: 50 * s, x1: 200 * s, y1: 150 * s };
    const [x, y, w, h] = bboxToVisibleRect(box, [s, s], land, 0);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(612 - 150);
    expect(w).toBeCloseTo(100);
    expect(h).toBeCloseTo(100);
  });
});

describe("detectScale", () => {
  it("renders at 50 dpi", () => {
    expect(detectScale([612, 792])).toBeCloseTo(50 / 72, 9);
  });
  it("caps the longest side at 2000 px", () => {
    // 14400 pt at 50 dpi would be 10000 px.
    expect(detectScale([14400, 1000]) * 14400).toBeCloseTo(MAX_DETECT_PX, 6);
    expect(detectScale([1000, 14400]) * 14400).toBeCloseTo(2000, 6);
  });
});
