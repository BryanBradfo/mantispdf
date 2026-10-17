import { describe, expect, it } from "vitest";
import { composeTransform, imagesPdfName, imagesProblem, layoutSummary, turn } from "./imagesToPdf";

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
});
