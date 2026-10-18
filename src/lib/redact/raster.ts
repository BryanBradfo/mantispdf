/**
 * Raster fallback for pages the engine cannot redact in place: pdf.js renders the page's
 * visible box at 200 dpi (annotations off, so nothing extra is baked in), the areas are painted
 * on the canvas (the engine paints them again), and the RGBA pixels go to the engine.
 * Sizes are in points: pdf.js 4 ignores a page's /UserUnit, and the engine accepts a raster
 * sized either in points or in UserUnit-scaled points.
 */
import { pdfjs } from "../pdf";
import type { Rect } from "./model";
import type { Fill, RasterWire } from "./toJob";

export const RASTER_DPI = 200;

/** Pixel size of a `width` x `height` pt visible box at `dpi`. */
export function rasterSize(width: number, height: number, dpi: number): [number, number] {
  return [Math.round((width * dpi) / 72), Math.round((height * dpi) / 72)];
}

/** Lowest dpi a raster may use, and the most bytes the rasters of one job may take together. */
export const MIN_RASTER_DPI = 100;
export const MAX_RASTER_BYTES = 512 * 1024 * 1024;

/** RGBA bytes of rasters of `pages` (visible sizes in points) at `dpi`. */
export function rasterBytes(pages: readonly [number, number][], dpi: number): number {
  let total = 0;
  for (const [w, h] of pages) {
    const [pw, ph] = rasterSize(w, h, dpi);
    total += pw * ph * 4;
  }
  return total;
}

/**
 * The dpi for the rasters of `pages`: `RASTER_DPI`, or the highest whole dpi down to
 * `MIN_RASTER_DPI` whose rasters fit `MAX_RASTER_BYTES` together; null when not even that fits.
 */
export function chooseDpi(pages: readonly [number, number][], budget = MAX_RASTER_BYTES): number | null {
  for (let dpi = RASTER_DPI; dpi >= MIN_RASTER_DPI; dpi--) {
    if (rasterBytes(pages, dpi) <= budget) return dpi;
  }
  return null;
}

/** A visible rect as canvas pixels `[x, y, w, h]` (y down from the top), rounded outwards. */
export function rectToPixels([x, y, w, h]: Rect, scale: number, heightPx: number): [number, number, number, number] {
  const left = Math.floor(x * scale);
  const right = Math.ceil((x + w) * scale);
  const top = Math.floor(heightPx - (y + h) * scale);
  const bottom = Math.ceil(heightPx - y * scale);
  return [left, top, right - left, bottom - top];
}

type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

/** Render page `pageNumber` of `pdf` with `rects` painted in `fill`, as the engine's raster. */
export async function renderRaster(pdf: PdfDocument, pageNumber: number, rects: Rect[], fill: Fill, dpi = RASTER_DPI): Promise<RasterWire> {
  const page = await pdf.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });
  const [width, height] = rasterSize(unscaled.width, unscaled.height, dpi);
  // Scale so the viewport is exactly the canvas size.
  const viewport = page.getViewport({ scale: width / unscaled.width });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D canvas context");
  try {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
    ctx.fillStyle = fill === "white" ? "#ffffff" : "#000000";
    const scale = width / unscaled.width;
    for (const rect of rects) ctx.fillRect(...rectToPixels(rect, scale, height));
    const data = ctx.getImageData(0, 0, width, height).data;
    return { page: pageNumber, width, height, dpi, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally {
    page.cleanup();
    canvas.width = 0;
    canvas.height = 0;
  }
}
