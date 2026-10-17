import { describe, expect, it } from "vitest";
import type { ExtractedImage } from "./imageInput";
import { filterImages, imageFileName, jpegSize, skippedSummary } from "./extractImages";

const rgba = (page: number, index: number, w: number, h: number): ExtractedImage => ({
  page, index, kind: "rgba", width: w, height: h, pixels: new Uint8Array(w * h * 4),
});
const jpeg = (page: number, index: number, w: number, h: number): ExtractedImage => ({
  page, index, kind: "jpeg",
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xd9]),
});

describe("extract images helpers", () => {
  it("names files by page and index", () => {
    expect(imageFileName(jpeg(2, 3, 40, 40))).toBe("page2_img3.jpg");
    expect(imageFileName(rgba(10, 1, 40, 40))).toBe("page10_img1.png");
  });

  it("reads JPEG dimensions", () => {
    const j = jpeg(1, 1, 300, 200);
    if (j.kind !== "jpeg") throw new Error("kind");
    expect(jpegSize(j.bytes)).toEqual({ width: 300, height: 200 });
  });

  it("filters small images only when asked", () => {
    const imgs = [rgba(1, 1, 16, 16), rgba(1, 2, 100, 10), jpeg(1, 3, 20, 20), jpeg(1, 4, 64, 64)];
    expect(filterImages(imgs, true).map((i) => i.index)).toEqual([2, 4]);
    expect(filterImages(imgs, false)).toHaveLength(4);
  });

  it("summarises skipped reasons", () => {
    expect(skippedSummary([])).toBe("");
    expect(skippedSummary([{ reason: "jpeg2000", count: 2 }, { reason: "corrupt", count: 1 }])).toBe(
      "3 images skipped: 2 JPEG 2000, 1 corrupt",
    );
    expect(skippedSummary([{ reason: "inline", count: 1 }])).toBe("1 image skipped: 1 inline");
  });
});
