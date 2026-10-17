import { describe, expect, it } from "vitest";
import {
  buildSignJob,
  clampVisibleRect,
  initialSignatureRect,
  previewToVisibleRect,
  signedOnOrigin,
  trimTransparent,
  visibleToPreviewRect,
} from "./signPlacement";

describe("previewToVisibleRect", () => {
  it("maps a portrait preview to visible points with a bottom-left origin", () => {
    // Letter page 612 x 792 shown 306 x 396 (scale 0.5).
    const rect = previewToVisibleRect({ left: 50, top: 100, width: 60, height: 20 }, [306, 396], [612, 792]);
    expect(rect).toEqual([100, (396 - 100 - 20) * 2, 120, 40]);
  });

  it("uses the visible (rotated) size for a landscape page", () => {
    // A portrait MediaBox with /Rotate 90 is displayed 792 x 612.
    const rect = previewToVisibleRect({ left: 0, top: 0, width: 132, height: 51 }, [528, 408], [792, 612]);
    const [x, y, w, h] = rect;
    expect(x).toBeCloseTo(0);
    expect(w).toBeCloseTo(198);
    expect(h).toBeCloseTo(76.5);
    expect(y + h).toBeCloseTo(612); // box touches the top edge
  });

  it("scales x and y independently when the aspect differs", () => {
    expect(previewToVisibleRect({ left: 10, top: 0, width: 10, height: 10 }, [100, 100], [200, 400])).toEqual([20, 360, 20, 40]);
  });

  it("round-trips with visibleToPreviewRect", () => {
    const box = { left: 12.5, top: 40, width: 80, height: 30 };
    const back = visibleToPreviewRect(previewToVisibleRect(box, [400, 300], [792, 612]), [400, 300], [792, 612]);
    expect(back.left).toBeCloseTo(box.left);
    expect(back.top).toBeCloseTo(box.top);
    expect(back.width).toBeCloseTo(box.width);
    expect(back.height).toBeCloseTo(box.height);
  });
});

describe("clampVisibleRect", () => {
  it("keeps the rect inside the page", () => {
    expect(clampVisibleRect([-10, 700, 100, 50], [612, 792])).toEqual([0, 700, 100, 50]);
    expect(clampVisibleRect([600, -5, 100, 50], [612, 792])).toEqual([512, 0, 100, 50]);
  });
  it("shrinks an oversized rect keeping its aspect", () => {
    expect(clampVisibleRect([0, 0, 1224, 100], [612, 792])).toEqual([0, 0, 612, 50]);
    expect(clampVisibleRect([0, 0, 100, 1584], [612, 792])).toEqual([0, 0, 50, 792]);
  });
});

describe("initialSignatureRect", () => {
  it("keeps the signature aspect and fits the page", () => {
    const [x, y, w, h] = initialSignatureRect(4, [612, 792]);
    expect(w / h).toBeCloseTo(4);
    expect(x + w).toBeLessThanOrEqual(612);
    expect(y).toBeGreaterThanOrEqual(0);
  });
  it("fits a tiny page", () => {
    const [x, y, w, h] = initialSignatureRect(0.5, [50, 40]);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y + h).toBeLessThanOrEqual(40);
    expect(w).toBeLessThanOrEqual(50);
  });
});

describe("signedOnOrigin", () => {
  it("puts the text under the box", () => {
    expect(signedOnOrigin([100, 200, 150, 50], 9)).toEqual([100, 189]);
  });
  it("moves above the box when there is no room below", () => {
    expect(signedOnOrigin([100, 5, 150, 50], 9, 792)).toEqual([100, 58]);
  });
});

describe("trimTransparent", () => {
  const px = (w: number, h: number, opaque: Array<[number, number]>) => {
    const p = new Uint8Array(w * h * 4);
    for (const [x, y] of opaque) p.set([10, 20, 30, 255], (y * w + x) * 4);
    return p;
  };
  it("crops to the opaque pixels", () => {
    const out = trimTransparent(px(5, 4, [[1, 1], [3, 2]]), 5, 4);
    expect(out).not.toBeNull();
    expect(out!.width).toBe(3);
    expect(out!.height).toBe(2);
    expect(Array.from(out!.pixels.slice(0, 4))).toEqual([10, 20, 30, 255]);
    expect(Array.from(out!.pixels.slice((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4))).toEqual([10, 20, 30, 255]);
  });
  it("returns null for a fully transparent image", () => {
    expect(trimTransparent(new Uint8Array(16), 2, 2)).toBeNull();
  });
});

describe("buildSignJob", () => {
  const sig = { width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 255]) };
  it("stamps only the image on the chosen page without a date", () => {
    const job = buildSignJob(sig, 3, [10, 20, 30, 15], [612, 792], null);
    expect(job.pages).toEqual([]);
    expect(job.texts).toEqual([]);
    expect(job.images[0]).toMatchObject({ page: 3, rect: [10, 20, 30, 15], opacity: 1 });
  });
  it("adds the signed-on line under the box, on that page only", () => {
    const job = buildSignJob(sig, 2, [100, 200, 150, 50], [612, 792], "Signed on 2026-10-17");
    expect(job.texts).toHaveLength(1);
    expect(job.texts[0]).toMatchObject({ template: "Signed on 2026-10-17", at: [100, 189], page: 2 });
  });
});
