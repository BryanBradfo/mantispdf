import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_IMAGES, MAX_IMAGE_PIXELS, MAX_INPUT_BYTES, inputBytesProblem, marginProblem, totalSizeProblem, pixelBudgetProblem, sniffImageType, composeTransform, imagesPdfName, imagesProblem, layoutSummary, turn } from "./imagesToPdf";
import { tFor } from "../i18n/testUtils";

const tImg = tFor("imagesToPdf");

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
    expect(imagesProblem(301, 10, tImg)).toMatch(/Too many/);
    expect(imagesProblem(2, NaN, tImg)).toMatch(/Margin/);
    expect(imagesProblem(2, 201, tImg)).toMatch(/Margin/);
    expect(imagesProblem(2, 0, tImg)).toBeNull();
  });
  it("summarises and names", () => {
    expect(layoutSummary(1, "A4", "auto", 10, tImg)).toBe("1 image · 1 page · A4 · auto · margin 10 mm");
    expect(layoutSummary(3, "Fit to image", "auto", NaN, tImg)).toContain("3 images · 3 pages");
    expect(imagesPdfName(["photo.final.jpg"])).toBe("photo.final.pdf");
    expect(imagesPdfName(["a.png", "b.png"])).toBe("images.pdf");
  });
  it("checks the margin against the paper", () => {
    // 10 mm on A4 is fine; 150 mm leaves nothing of a 210 mm wide page.
    expect(marginProblem(10, [595.28, 841.89], tImg)).toBeNull();
    expect(marginProblem(150, [595.28, 841.89], tImg)).toMatch(/Margin is too large for this page size/);
    expect(marginProblem(150, "fit", tImg)).toBeNull();
    expect(marginProblem(NaN, [595.28, 841.89], tImg)).toBeNull();
  });
  it("checks pixel budgets", () => {
    expect(pixelBudgetProblem("a.png", 10001, 10000, tImg)).toMatch(/a\.png is too large/);
    expect(pixelBudgetProblem("c.png", 1000, 1000, tImg)).toBeNull();
  });
  it("mirrors the engine budgets in crates/mantis-wasm/src/images/to_pdf.rs", () => {
    const rust = readFileSync(join(process.cwd(), "crates/mantis-wasm/src/images/to_pdf.rs"), "utf8");
    const constant = (name: string) => {
      const m = new RegExp(`const ${name}: \\w+ = ([^;]+);`).exec(rust);
      if (!m) throw new Error(`${name} not found`);
      // Plain products of integer literals, e.g. `512 * 1024 * 1024`.
      return m[1].split("*").reduce((acc, part) => acc * Number(part.trim().replace(/_/g, "")), 1);
    };
    expect(MAX_INPUT_BYTES).toBe(constant("MAX_INPUT_BYTES"));
    expect(MAX_IMAGE_PIXELS).toBe(constant("MAX_IMAGE_PIXELS"));
    expect(MAX_IMAGES).toBe(constant("MAX_IMAGES"));
    expect(MAX_INPUT_BYTES).toBe(512 * 1024 * 1024);
  });
  it("checks the input byte budget before and while reading", () => {
    const mb = 1024 * 1024;
    expect(totalSizeProblem([{ name: "a.jpg", size: 300 * mb }, { name: "b.jpg", size: 200 * mb }], tImg)).toBeNull();
    expect(totalSizeProblem([{ name: "a.jpg", size: 300 * mb }, { name: "b.jpg", size: 213 * mb }], tImg)).toMatch(/b\.jpg/);
    expect(totalSizeProblem([{ name: "a.jpg", size: 300 * mb }, { name: "b.jpg", size: 213 * mb }], tImg)).toMatch(/512 MB/);
    expect(inputBytesProblem("c.png", 4 * 8000 * 8000, 300 * mb, tImg)).toMatch(/Adding c\.png .*512 MB/);
    expect(inputBytesProblem("c.png", 100 * mb, 300 * mb, tImg)).toBeNull();
    expect(inputBytesProblem("c.png", MAX_INPUT_BYTES, 0, tImg)).toBeNull();
  });
  it("sniffs image types", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageType(webp)).toBe("image/webp");
    expect(sniffImageType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe("images-to-PDF messages in French", () => {
  const t = tFor("imagesToPdf", "fr");
  it("explains the limits in French", () => {
    expect(imagesProblem(301, 10, t)).toBe("Trop d’images\u00a0: la limite est de 300 par PDF.");
    expect(layoutSummary(1, "A4", "auto", 10, t)).toBe("1 image · 1 page · A4 · auto · marge de 10\u00a0mm");
    expect(layoutSummary(2, "A4", "paysage", 0, t)).toBe("2 images · 2 pages · A4 · paysage · marge de 0\u00a0mm");
  });
});
