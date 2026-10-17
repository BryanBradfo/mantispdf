import type { StampJobSpec } from "./stampJob";

/** A box in preview pixels, origin top-left (CSS layout). */
export interface PreviewBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Visible-space rect `[x, y, w, h]` in points, origin bottom-left of the displayed page. */
export type VisibleRect = [number, number, number, number];
export type Size = [number, number];

/** Trimmed RGBA signature image. */
export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * Map a box drawn over the page preview to visible page space. The preview shows the page as
 * displayed (CropBox, /Rotate applied), so `visibleSize` must be the rotated size: a portrait
 * MediaBox with /Rotate 90 is a landscape `[h, w]`.
 */
export function previewToVisibleRect(box: PreviewBox, previewSize: Size, visibleSize: Size): VisibleRect {
  const [pw, ph] = previewSize;
  const [vw, vh] = visibleSize;
  const sx = vw / pw;
  const sy = vh / ph;
  return [box.left * sx, (ph - box.top - box.height) * sy, box.width * sx, box.height * sy];
}

/** Inverse of `previewToVisibleRect`. */
export function visibleToPreviewRect(rect: VisibleRect, previewSize: Size, visibleSize: Size): PreviewBox {
  const [pw, ph] = previewSize;
  const [vw, vh] = visibleSize;
  const sx = pw / vw;
  const sy = ph / vh;
  const [x, y, w, h] = rect;
  return { left: x * sx, top: ph - (y + h) * sy, width: w * sx, height: h * sy };
}

/** Keep `rect` on the page: shrink it (keeping its aspect) if it is larger, then move it inside. */
export function clampVisibleRect(rect: VisibleRect, page: Size): VisibleRect {
  const [pw, ph] = page;
  let [x, y, w, h] = rect;
  const scale = Math.min(1, pw / w, ph / h);
  w *= scale;
  h *= scale;
  x = Math.min(Math.max(x, 0), pw - w);
  y = Math.min(Math.max(y, 0), ph - h);
  return [x, y, w, h];
}

/** Default placement: about 180 pt wide, near the bottom-right corner, `aspect` = width / height. */
export function initialSignatureRect(aspect: number, page: Size): VisibleRect {
  const [pw, ph] = page;
  let w = Math.min(180, pw * 0.4);
  let h = w / aspect;
  if (h > ph * 0.3) {
    h = ph * 0.3;
    w = h * aspect;
  }
  const x = pw - w - Math.min(54, pw * 0.08);
  const y = Math.min(72, ph * 0.1);
  return clampVisibleRect([x, y, w, h], page);
}

/** Baseline origin of the "Signed on" line: just under the box, or just above it when there is no room. */
export function signedOnOrigin(rect: VisibleRect, size: number, pageHeight = Infinity): [number, number] {
  const [x, y, , h] = rect;
  const below = y - size - 2;
  if (below >= 2) return [x, below];
  return [x, Math.min(y + h + 3, pageHeight - size)];
}

/** Crop fully transparent margins. Returns null when nothing is opaque. */
export function trimTransparent(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): RgbaImage | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const start = ((minY + y) * width + minX) * 4;
    out.set(pixels.subarray(start, start + w * 4), y * w * 4);
  }
  return { width: w, height: h, pixels: out };
}

export const SIGNED_ON_SIZE = 9;

/**
 * Stamp job for a visual signature: the image on `page` at `rect`, plus an optional
 * "Signed on <date>" line (absolute text on that page only, under the box).
 */
export function buildSignJob(
  signature: RgbaImage,
  page: number,
  rect: VisibleRect,
  pageSize: Size,
  signedOn: string | null,
): StampJobSpec {
  return {
    pages: [],
    numberStart: 1,
    images: [
      {
        image: { kind: "rgba", width: signature.width, height: signature.height, pixels: signature.pixels },
        page,
        rect,
        opacity: 1,
      },
    ],
    texts: signedOn === null
      ? []
      : [
          {
            template: signedOn,
            font: "Helvetica",
            size: SIGNED_ON_SIZE,
            color: [0.2, 0.2, 0.2],
            opacity: 1,
            anchor: "bottom-left",
            marginX: 0,
            marginY: 0,
            at: signedOnOrigin(rect, SIGNED_ON_SIZE, pageSize[1]),
            page,
          },
        ],
  };
}
