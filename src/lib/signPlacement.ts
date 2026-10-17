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

/**
 * Resize `rect` by `delta` points of width around its top-left corner, keeping its aspect ratio:
 * never narrower than `minWidth`, never past the right or bottom edge of `page`.
 */
export function resizeVisibleRect(rect: VisibleRect, delta: number, page: Size, minWidth: number): VisibleRect {
  const [pw] = page;
  const [x, y, w, h] = rect;
  const aspect = w / h;
  const top = y + h;
  const maxWidth = Math.max(minWidth, Math.min(pw - x, top * aspect));
  const width = Math.min(maxWidth, Math.max(minWidth, w + delta));
  const height = width / aspect;
  return [x, top - height, width, height];
}

/** Spoken description of a signature placement, from the top-left of the page as it is shown. */
export function describePlacement(rect: VisibleRect, page: Size): string {
  const [x, y, w, h] = rect;
  const r = Math.round;
  return `Signature ${r(w)} by ${r(h)} pt, ${r(x)} pt from the left, ${r(page[1] - (y + h))} pt from the top.`;
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

/**
 * Width estimate of a Helvetica line: 0.56 em per character. That is a Helvetica digit (556/1000),
 * wider than the average of mixed text, so a date line is never underestimated.
 */
export function estimateTextWidth(text: string, size: number): number {
  return 0.56 * size * text.length;
}

/**
 * Baseline origin of the "Signed on" line: just under the box, or just above it when there is no
 * room; pulled left so the whole line ends at least 2 pt inside the page.
 */
export function signedOnOrigin(rect: VisibleRect, size: number, page: Size, text: string): [number, number] {
  const [pw, ph] = page;
  const [bx, by, , bh] = rect;
  const x = Math.max(0, Math.min(bx, pw - estimateTextWidth(text, size) - 2));
  const below = by - size - 2;
  const y = below >= 2 ? below : Math.max(0, Math.min(by + bh + 3, ph - size));
  return [x, y];
}

/** Pixels whose r, g and b are all at least this value start to fade out. */
const WHITE_FADE_START = 235;
/** ... and are fully transparent from this value. */
const WHITE_FADE_END = 250;

/**
 * Make a scanned or photographed signature's paper transparent: with m = min(r, g, b), alpha is
 * kept below 235, scaled down linearly from 235 to 250 (soft edge), and 0 from 250. Returns a copy.
 */
export function removeWhiteBackground(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels);
  for (let i = 0; i < out.length; i += 4) {
    const m = Math.min(out[i], out[i + 1], out[i + 2]);
    if (m < WHITE_FADE_START) continue;
    const keep = Math.max(0, (WHITE_FADE_END - m) / (WHITE_FADE_END - WHITE_FADE_START));
    out[i + 3] = Math.round(out[i + 3] * keep);
  }
  return out;
}

/**
 * Font size for a typed signature so the text (`textWidth` measured at `size`) plus `size` of
 * padding fits a canvas `maxWidth` wide. Returns `size` when it already fits.
 */
export function fitTypedFontSize(textWidth: number, size: number, maxWidth: number): number {
  const needed = textWidth + size;
  if (needed <= maxWidth) return size;
  return Math.max(1, Math.floor((size * maxWidth) / needed));
}

/**
 * On-screen size of the placement preview: as wide as `available` (at most `maxWidth`), height from
 * the page aspect, capped at `maxHeight` (then the width follows). A degenerate page or container
 * falls back to a Letter-shaped preview so the layout never gets NaN or zero sizes.
 */
export function placementPreviewSize(available: number, page: Size, maxWidth: number, maxHeight: number): Size {
  const [vw, vh] = page;
  const aspect = vw > 0 && vh > 0 && Number.isFinite(vw / vh) ? vw / vh : 612 / 792;
  let w = available > 0 && Number.isFinite(available) ? Math.min(maxWidth, available) : maxWidth;
  let h = w / aspect;
  if (h > maxHeight) {
    h = maxHeight;
    w = h * aspect;
  }
  return [w, h];
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
            at: signedOnOrigin(rect, SIGNED_ON_SIZE, pageSize, signedOn),
            page,
          },
        ],
  };
}
