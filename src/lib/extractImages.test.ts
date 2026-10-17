import { describe, expect, it, vi } from "vitest";
import type { ExtractedImage } from "./imageInput";
import { PngCache, filterImages, imageFileName, jpegSize, reasonName, skippedSummary } from "./extractImages";

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
    expect(skippedSummary([{ reason: "inline", count: 1 }])).toBe("1 image skipped: 1 inline (embedded in page content, not extractable)");
  });
});

describe("reasonName", () => {
  it("maps known engine reasons and passes unknown ones through", () => {
    expect(reasonName("alpha dropped")).toBe("kept without transparency");
    expect(reasonName("inline")).toBe("inline (embedded in page content, not extractable)");
    expect(reasonName("mystery")).toBe("mystery");
  });
});

type Rgba = Extract<ExtractedImage, { kind: "rgba" }>;
const rg = (i: number) => rgba(1, i, 4, 4) as Rgba;

function gatedConverter() {
  let active = 0;
  let peak = 0;
  const gates: (() => void)[] = [];
  const convert = vi.fn(() => {
    active++;
    peak = Math.max(peak, active);
    return new Promise<Blob>((resolve) => {
      gates.push(() => {
        active--;
        resolve(new Blob(["x"]));
      });
    });
  });
  return { convert, gates, peak: () => peak };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PngCache", () => {
  it("runs at most 2 conversions at once and caches results", async () => {
    const g = gatedConverter();
    const converted: string[] = [];
    const cache = new PngCache({ convert: g.convert, onConverted: (k) => converted.push(k) });
    const ps = [1, 2, 3, 4].map((i) => cache.blob(rg(i)));
    await tick();
    expect(g.convert).toHaveBeenCalledTimes(2);
    while (g.gates.length) {
      g.gates.shift()?.();
      await tick();
    }
    await Promise.all(ps);
    expect(g.peak()).toBe(2);
    expect(g.convert).toHaveBeenCalledTimes(4);
    await cache.blob(rg(1));
    expect(g.convert).toHaveBeenCalledTimes(4);
    expect(converted).toHaveLength(4);
  });

  it("dispose rejects queued jobs and later requests", async () => {
    const g = gatedConverter();
    const cache = new PngCache({ convert: g.convert });
    cache.blob(rg(1)).catch(() => undefined);
    cache.blob(rg(2)).catch(() => undefined);
    const queued = cache.blob(rg(3));
    await tick();
    cache.dispose();
    await expect(queued).rejects.toThrow("Cancelled");
    await expect(cache.blob(rg(4))).rejects.toThrow("Cancelled");
    expect(g.convert).toHaveBeenCalledTimes(2);
    expect(cache.disposed).toBe(true);
  });
});
