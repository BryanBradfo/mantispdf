import { describe, expect, it } from "vitest";
import { pixelBudgetProblem, sniffImageType, composeTransform, imagesPdfName, imagesProblem, layoutSummary, turn } from "./imagesToPdf";

describe("imagesToPdf helpers", () => {
  it("composes rotation with exif, keeping the flip", () => {
    expect(composeTransform({ rotate: 90, flipX: true }, 270)).toEqual({ rotate: 0, flipX: true });
    expect(composeTransform({ rotate: 0, flipX: false }, 90)).toEqual({ rotate: 90, flipX: false });
  });
  it("turns by quarters", () => {
    expect(turn(0, -1)).toBe(270);
    expect(turn(270, 1)).toBe(0);
    expect(turn(90, 1)).toBe(180);
  });
  it("validates", () => {
    expect(imagesProblem(301, 10)).toMatch(/Too many/);
    expect(imagesProblem(2, NaN)).toMatch(/Margin/);
    expect(imagesProblem(2, 201)).toMatch(/Margin/);
    expect(imagesProblem(2, 0)).toBeNull();
  });
  it("summarises and names", () => {
    expect(layoutSummary(1, "A4", "auto", 10)).toBe("1 image · 1 page · A4 · auto · margin 10 mm");
    expect(layoutSummary(3, "Fit to image", "auto", NaN)).toContain("3 images · 3 pages");
    expect(imagesPdfName(["photo.final.jpg"])).toBe("photo.final.pdf");
    expect(imagesPdfName(["a.png", "b.png"])).toBe("images.pdf");
  });
  it("checks pixel budgets", () => {
    expect(pixelBudgetProblem("a.png", 10001, 10000, 0)).toMatch(/a\.png is too large/);
    expect(pixelBudgetProblem("b.png", 1000, 1000, 399_500_000)).toMatch(/400 megapixel/);
    expect(pixelBudgetProblem("c.png", 1000, 1000, 0)).toBeNull();
  });
  it("sniffs image types", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageType(webp)).toBe("image/webp");
    expect(sniffImageType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
