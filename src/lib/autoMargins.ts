import type { Rect } from "./geometryJob";

/** Render resolution of the auto-detect pass. */
export const DETECT_DPI = 50;
/** Longest side of the auto-detect render, in pixels (a huge page is rendered smaller). */
export const MAX_DETECT_PX = 2000;
/** A pixel is content when any of r, g, b is below this value. */
export const WHITE_THRESHOLD = 245;
/** Pixels this close to the image edge are ignored (anti-aliased page border, scanner edge). */
export const IGNORED_BORDER_PX = 1;
/** Space kept around the detected content, in points. */
export const CONTENT_PADDING_PT = 6;

/** Pixel bounding box, origin top-left; `x1`/`y1` are exclusive. */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Bounding box of the non-white pixels of an RGBA image, ignoring `border` pixels on each side.
 * Returns null when nothing (inside the border) is darker than `threshold`.
 */
export function contentBBox(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  threshold = WHITE_THRESHOLD,
  border = IGNORED_BORDER_PX,
): PixelBox | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = border; y < height - border; y++) {
    const row = y * width * 4;
    for (let x = border; x < width - border; x++) {
      const i = row + x * 4;
      if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * Map a pixel box of a page rendered at `pxPerPt` (x and y) to a visible-space rect (points, origin
 * bottom-left), padded by `pad` points and clamped to the page. No box means the whole page.
 * The render is of the displayed page (pdf.js applies the CropBox and /Rotate), so only y flips.
 */
export function bboxToVisibleRect(
  box: PixelBox | null,
  pxPerPt: [number, number],
  page: [number, number],
  pad = CONTENT_PADDING_PT,
): Rect {
  const [vw, vh] = page;
  if (!box) return [0, 0, vw, vh];
  const [sx, sy] = pxPerPt;
  const left = Math.max(0, box.x0 / sx - pad);
  const right = Math.min(vw, box.x1 / sx + pad);
  const top = Math.min(vh, vh - box.y0 / sy + pad);
  const bottom = Math.max(0, vh - box.y1 / sy - pad);
  if (!(right > left && top > bottom)) return [0, 0, vw, vh];
  return [left, bottom, right - left, top - bottom];
}

/** Render scale (pixels per point) for a page of `[w, h]` points: 50 dpi, capped at `MAX_DETECT_PX`. */
export function detectScale([w, h]: [number, number]): number {
  const longest = Math.max(w, h);
  const dpi = DETECT_DPI / 72;
  return longest > 0 ? Math.min(dpi, MAX_DETECT_PX / longest) : dpi;
}

export interface DetectOptions {
  /** Called after each page with the number of pages done so far. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Detect the content box of each of `pages` (1-based) of `bytes`, rendering locally with pdf.js at
 * 50 dpi (at most 2000 px on the longest side). `sizes` are the visible page sizes in points
 * (index = page - 1). Nothing leaves the device.
 */
export async function detectContentRects(
  bytes: Uint8Array,
  pages: readonly number[],
  sizes: readonly [number, number][],
  { onProgress, signal }: DetectOptions = {},
): Promise<Map<number, Rect>> {
  // Loaded on demand: keeps pdf.js out of this module's unit tests and out of the initial chunk.
  const { pdfjs } = await import("./pdf");
  // A copy: pdf.js transfers the buffer to its worker, which would detach the caller's bytes.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const out = new Map<number, Rect>();
  try {
    const pdf = await task.promise;
    for (const [i, n] of pages.entries()) {
      signal?.throwIfAborted();
      const size = sizes[n - 1];
      const page = await pdf.getPage(n);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: detectScale([natural.width, natural.height]) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      try {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("2D canvas unavailable");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const box = contentBBox(image.data, image.width, image.height);
        const [vw, vh] = size ?? [natural.width, natural.height];
        const usable = vw > 0 && vh > 0 && viewport.width > 0 && viewport.height > 0;
        out.set(n, usable ? bboxToVisibleRect(box, [viewport.width / vw, viewport.height / vh], [vw, vh]) : [0, 0, vw, vh]);
      } finally {
        page.cleanup();
        canvas.width = 0; // release the backing store immediately
        canvas.height = 0;
      }
      onProgress?.(i + 1, pages.length);
    }
    return out;
  } finally {
    void task.destroy();
  }
}
