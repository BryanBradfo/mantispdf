import { describe, expect, it } from "vitest";
import {
  buildSignJob,
  clampVisibleRect,
  describePlacement,
  estimateTextWidth,
  fitTypedFontSize,
  initialSignatureRect,
  placementPreviewSize,
  previewToVisibleRect,
  removeWhiteBackground,
  resizeVisibleRect,
  signedOnOrigin,
  trimTransparent,
  visibleToPreviewRect,
} from "./signPlacement";
import { tFor } from "../i18n/testUtils";

const tSign = tFor("sign");

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
  const text = "Signed on 2026-10-17";
  it("puts the text under the box", () => {
    expect(signedOnOrigin([100, 200, 150, 50], 9, [612, 792], text)).toEqual([100, 189]);
  });
  it("moves above the box when there is no room below", () => {
    expect(signedOnOrigin([100, 5, 150, 50], 9, [612, 792], text)).toEqual([100, 58]);
  });
  it("pulls the text left so it ends inside the page", () => {
    const [x] = signedOnOrigin([560, 200, 50, 20], 9, [612, 792], text);
    expect(x + estimateTextWidth(text, 9)).toBeLessThanOrEqual(612 - 2);
    expect(x).toBeGreaterThanOrEqual(0);
  });
  it("keeps the baseline inside the page when the box fills the height", () => {
    const [, y] = signedOnOrigin([0, 0, 100, 792], 9, [612, 792], text);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y + 9).toBeLessThanOrEqual(792);
  });
  it("starts at 0 when the text is wider than the page", () => {
    expect(signedOnOrigin([10, 200, 20, 20], 9, [50, 792], text)[0]).toBe(0);
  });
});

describe("estimateTextWidth", () => {
  it("is a per-character estimate that covers Helvetica digits", () => {
    // Real Helvetica width of this line at 9 pt is about 89 pt.
    expect(estimateTextWidth("Signed on 2026-10-17", 9)).toBeGreaterThanOrEqual(89);
    expect(estimateTextWidth("", 9)).toBe(0);
  });
});

describe("removeWhiteBackground", () => {
  const one = (r: number, g: number, b: number, a = 255) => Array.from(removeWhiteBackground(new Uint8ClampedArray([r, g, b, a])));
  it("makes near-white fully transparent", () => {
    expect(one(255, 255, 255)[3]).toBe(0);
    expect(one(250, 252, 251)[3]).toBe(0);
  });
  it("ramps alpha between 235 and 250", () => {
    expect(one(240, 245, 250)[3]).toBe(170);
    expect(one(235, 235, 235)[3]).toBe(255);
    expect(one(245, 245, 245, 128)[3]).toBe(43);
  });
  it("keeps ink and any pixel with one channel under 235", () => {
    expect(one(31, 42, 68)).toEqual([31, 42, 68, 255]);
    expect(one(234, 255, 255)).toEqual([234, 255, 255, 255]);
  });
  it("does not modify the input", () => {
    const src = new Uint8ClampedArray([255, 255, 255, 255]);
    removeWhiteBackground(src);
    expect(src[3]).toBe(255);
  });
  it("lets trimTransparent crop a white margin", () => {
    // 3x1: white, ink, white
    const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const out = trimTransparent(removeWhiteBackground(px), 3, 1);
    expect(out?.width).toBe(1);
  });
});

describe("fitTypedFontSize", () => {
  it("keeps the size when the text fits", () => {
    expect(fitTypedFontSize(1000, 96, 4000)).toBe(96);
  });
  it("scales down so text plus padding fits the canvas", () => {
    const s = fitTypedFontSize(7904, 96, 4000);
    expect(s).toBe(48);
    expect((7904 * s) / 96 + s).toBeLessThanOrEqual(4000);
  });
});

describe("placementPreviewSize", () => {
  it("uses the available width for a portrait page", () => {
    expect(placementPreviewSize(560, [612, 792], 560, 800)).toEqual([560, (560 * 792) / 612]);
  });
  it("is narrower when the container is", () => {
    expect(placementPreviewSize(300, [600, 300], 560, 800)).toEqual([300, 150]);
  });
  it("caps the height and derives the width from it for a tall page", () => {
    expect(placementPreviewSize(560, [100, 1000], 560, 800)).toEqual([80, 800]);
  });
  it("guards a degenerate page or container", () => {
    for (const [avail, size] of [[560, [0, 792]], [560, [612, -1]], [0, [612, 792]], [560, [NaN, 792]]] as const) {
      const [w, h] = placementPreviewSize(avail, [size[0], size[1]], 560, 800);
      expect(Number.isFinite(w) && w > 0).toBe(true);
      expect(Number.isFinite(h) && h > 0 && h <= 800).toBe(true);
    }
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

describe("buildSignJob signed-on clamp", () => {
  const sig = { width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 255]) };
  it("keeps the line inside the page for a box at the right edge", () => {
    const text = "Signed on 2026-10-17";
    const job = buildSignJob(sig, 1, [570, 300, 40, 20], [612, 792], text);
    const [x] = job.texts[0].at!;
    expect(x + estimateTextWidth(text, 9)).toBeLessThanOrEqual(610);
  });
});

describe("resizeVisibleRect", () => {
  const page: [number, number] = [600, 800];
  it("grows and shrinks around the top-left corner, keeping the aspect", () => {
    // Top edge at y + h = 300.
    expect(resizeVisibleRect([100, 200, 200, 100], 10, page, 8)).toEqual([100, 195, 210, 105]);
    expect(resizeVisibleRect([100, 200, 200, 100], -100, page, 8)).toEqual([100, 250, 100, 50]);
  });
  it("never shrinks below the minimum width", () => {
    expect(resizeVisibleRect([100, 200, 20, 10], -100, page, 8)).toEqual([100, 206, 8, 4]);
  });
  it("stops at the right edge and at the bottom edge", () => {
    expect(resizeVisibleRect([500, 600, 50, 25], 500, page, 8)).toEqual([500, 575, 100, 50]);
    // Top at 40: the height can reach 40 at most, so the width 80.
    expect(resizeVisibleRect([10, 20, 40, 20], 500, page, 8)).toEqual([10, 0, 80, 40]);
  });
});

describe("describePlacement", () => {
  it("rounds to whole points, measured from the top-left of the page", () => {
    expect(describePlacement([100.4, 200.6, 150.2, 49.7], [600, 800], tSign)).toBe(
      "Signature 150 by 50 pt, 100 pt from the left, 550 pt from the top.",
    );
  });
});

describe("describePlacement in French", () => {
  it("reads the box in French", () => {
    expect(describePlacement([100, 200, 150, 50], [600, 800], tFor("sign", "fr"))).toBe(
      "Signature de 150 sur 50\u00a0pt, à 100\u00a0pt du bord gauche et 550\u00a0pt du haut.",
    );
  });
});
