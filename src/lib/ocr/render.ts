/**
 * Page images for OCR: pdf.js renders the page's visible box at 300 dpi (lower for pages that
 * would pass 25 Mpx or 16384 px on a side), annotations off, on white; the pixels become 8-bit
 * gray and are handed to tesseract as a binary PGM (no PNG encoding pass).
 */
import { pdfjs } from "../pdf";

export const OCR_DPI = 300;
export const MAX_OCR_PIXELS = 25_000_000;

/**
 * Longest image side: a margin under browsers' 32767 px canvas limit, and within what iOS
 * Safari can allocate.
 */
export const MAX_OCR_SIDE = 16384;

/**
 * Pixel size and dpi of the OCR image of a `widthPt` x `heightPt` visible box: 300 dpi, lowered
 * until the image has at most `MAX_OCR_PIXELS` pixels and no side over `MAX_OCR_SIDE`.
 */
export function ocrRenderSize(widthPt: number, heightPt: number): { width: number; height: number; dpi: number } {
  const at = (dpi: number) => [Math.max(1, Math.floor((widthPt * dpi) / 72)), Math.max(1, Math.floor((heightPt * dpi) / 72))];
  const fits = ([w, h]: number[]) => w * h <= MAX_OCR_PIXELS && Math.max(w, h) <= MAX_OCR_SIDE;
  let dpi = OCR_DPI;
  let size = at(dpi);
  if (!fits(size)) {
    const [w, h] = size;
    dpi = OCR_DPI * Math.min(Math.sqrt(MAX_OCR_PIXELS / (w * h)), MAX_OCR_SIDE / Math.max(w, h));
    size = at(dpi);
    // Flooring keeps it under; guard against rounding at the edge.
    while (!fits(size)) {
      dpi *= 0.999;
      size = at(dpi);
    }
  }
  return { width: size[0], height: size[1], dpi };
}

/** Rec. 601 luma of RGBA pixels, composited over white. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    const a = rgba[i + 3] / 255;
    const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    out[p] = Math.round(luma * a + 255 * (1 - a));
  }
  return out;
}

/** A binary PGM (P5) of `width` x `height` gray bytes. */
export function encodePgm(gray: Uint8Array, width: number, height: number): Uint8Array {
  if (gray.length !== width * height) throw new Error("Gray buffer does not match the image size");
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const out = new Uint8Array(header.length + gray.length);
  out.set(header);
  out.set(gray, header.length);
  return out;
}

/** One page ready for recognition: PGM bytes and the size and dpi they were rendered at. */
export interface OcrPageImage {
  pgm: Uint8Array;
  width: number;
  height: number;
  dpi: number;
}

type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

/** Render page `pageNumber` of `pdf` for OCR. */
export async function renderPageImage(pdf: PdfDocument, pageNumber: number): Promise<OcrPageImage> {
  const page = await pdf.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });
  const { width, height, dpi } = ocrRenderSize(unscaled.width, unscaled.height);
  const viewport = page.getViewport({ scale: width / unscaled.width });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get a 2D canvas context");
  try {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
    const gray = rgbaToGray(ctx.getImageData(0, 0, width, height).data);
    return { pgm: encodePgm(gray, width, height), width, height, dpi };
  } finally {
    page.cleanup();
    canvas.width = 0;
    canvas.height = 0;
  }
}
