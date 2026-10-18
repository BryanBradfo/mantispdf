import { describe, expect, it } from "vitest";
import { LIMITS, addError, clampWidth, imageBudgetError, imagePayloadBytes, type ImageItem, type ImageSource, type Item } from "./model";

const source = (bytes: number): ImageSource => ({ blob: new Blob([]), width: 10, height: 10, bytes });

const image = (id: string, bytes: number, page = 1): ImageItem => ({
  id,
  kind: "image",
  page,
  rect: [0, 0, 10, 10],
  image: source(bytes),
  opacity: 1,
  rotation: 0,
});

describe("LIMITS", () => {
  it("mirrors the engine image budget", () => {
    expect(LIMITS.maxImages).toBe(200);
    expect(LIMITS.maxImageBytes).toBe(256 * 1024 * 1024);
    expect(LIMITS.minStrokeWidth).toBeGreaterThan(0);
  });
});

describe("clampWidth", () => {
  it("lets rectangles and ellipses have no stroke", () => {
    expect(clampWidth("rect", 0)).toBe(0);
    expect(clampWidth("ellipse", -3)).toBe(0);
    expect(clampWidth("rect", 250)).toBe(LIMITS.maxWidth);
  });

  it("keeps lines and drawings visible", () => {
    expect(clampWidth("line", 0)).toBe(LIMITS.minStrokeWidth);
    expect(clampWidth("freehand", -1)).toBe(LIMITS.minStrokeWidth);
    expect(clampWidth("line", 3)).toBe(3);
    expect(clampWidth("freehand", 101)).toBe(LIMITS.maxWidth);
  });

  it("treats a non-number as the minimum", () => {
    expect(clampWidth("line", Number.NaN)).toBe(LIMITS.minStrokeWidth);
    expect(clampWidth("rect", Number.NaN)).toBe(0);
  });
});

describe("imagePayloadBytes", () => {
  it("is the file size for a JPEG passed through, else the RGBA pixels", () => {
    expect(imagePayloadBytes(1234, 100, 50, true)).toBe(1234);
    expect(imagePayloadBytes(1234, 100, 50, false)).toBe(100 * 50 * 4);
  });
});

describe("imageBudgetError", () => {
  it("accepts an image within both limits", () => {
    expect(imageBudgetError([], source(10))).toBeNull();
  });

  it("refuses the 201st image across all pages", () => {
    const items: Item[] = Array.from({ length: LIMITS.maxImages }, (_, i) => image(`i${i}`, 1, (i % 3) + 1));
    expect(imageBudgetError(items.slice(1), source(1))).toBeNull();
    expect(imageBudgetError(items, source(1))).toMatch(/200 images/);
  });

  it("refuses an image that would pass the byte budget, counting each distinct image once", () => {
    const half = LIMITS.maxImageBytes / 2;
    expect(imageBudgetError([image("a", half)], source(half))).toBeNull();
    expect(imageBudgetError([image("a", half), image("b", 1)], source(half))).toMatch(/256 MB/);
  });

  it("does not charge the bytes again for one more placement of an image already placed", () => {
    const big = source(LIMITS.maxImageBytes);
    const placed = (id: string): ImageItem => ({ ...image(id, 0), image: big });
    // The same picked image (same blob) is embedded once by the engine.
    expect(imageBudgetError([placed("a"), placed("b")], big)).toBeNull();
    // A different image of any size no longer fits.
    expect(imageBudgetError([placed("a")], source(1))).toMatch(/256 MB/);
  });
});

describe("addError", () => {
  const rect = (id: string): Item => ({
    id,
    kind: "rect",
    page: 1,
    rect: [0, 0, 1, 1],
    stroke: { kind: "none" },
    width: 0,
    fill: { kind: "none" },
    opacity: 1,
  });

  it("accepts an item while the document is under the item limit", () => {
    expect(addError([rect("a")], rect("b"))).toBeNull();
  });

  it("refuses any item past the item limit", () => {
    const items = Array.from({ length: LIMITS.items }, (_, i) => rect(`r${i}`));
    expect(addError(items, rect("x"))).toMatch(/2000 edits/);
  });

  it("applies the image budget to images (a duplicate counts again)", () => {
    const items: Item[] = Array.from({ length: LIMITS.maxImages }, (_, i) => image(`i${i}`, 1));
    expect(addError(items, items[0])).toMatch(/200 images/);
    expect(addError(items.slice(1), items[0])).toBeNull();
  });
});
