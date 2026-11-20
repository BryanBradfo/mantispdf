import { pdfjs } from "../pdf";
import type { Pixels } from "./pixelDiff";

/**
 * Page renders for the overlay view. Not through the ThumbnailStore: its renders come back as lossy
 * WebP blob URLs (compression noise would show as differences and blob URLs cannot be read back as
 * pixels); here pdf.js paints straight into canvases that are read once and shown as they are.
 */
export type OverlayDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

export async function openOverlayDoc(file: Blob): Promise<OverlayDoc> {
  // pdf.js transfers the buffer it is given: a fresh copy per document.
  const bytes = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data: bytes }).promise;
}

export function abortError(): Error {
  const e = new Error("Overlay cancelled");
  e.name = "AbortError";
  return e;
}

export const isAbort = (e: unknown) => e instanceof Error && (e.name === "AbortError" || e.name === "RenderingCancelledException");

/** Render page `n` (1-based) `pxWidth` device pixels wide, rotation applied (visible orientation). */
export async function renderPage(doc: OverlayDoc, n: number, pxWidth: number, signal: AbortSignal): Promise<HTMLCanvasElement> {
  if (signal.aborted) throw abortError();
  const page = await doc.getPage(n);
  try {
    if (signal.aborted) throw abortError();
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: pxWidth / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = pxWidth;
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    const task = page.render({ canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE });
    const stop = () => task.cancel();
    signal.addEventListener("abort", stop);
    try {
      await task.promise;
    } finally {
      signal.removeEventListener("abort", stop);
    }
    if (signal.aborted) throw abortError();
    return canvas;
  } finally {
    page.cleanup();
  }
}

/** A canvas `w` x `h` on a white page with `src` drawn at the top left (same width, maybe shorter). */
export function onWhite(src: HTMLCanvasElement | null, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  if (src) ctx.drawImage(src, 0, 0);
  return c;
}

/** The canvas pixels as a fresh buffer (handed over to the pixel worker). */
export function pixelsOf(c: HTMLCanvasElement): Pixels {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { width: img.width, height: img.height, data: img.data };
}

/** A canvas holding RGBA pixels (the overlay painted by the worker). */
export function canvasFrom(data: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.putImageData(new ImageData(data, w, h), 0, 0);
  return c;
}

/** Free a canvas's backing store now (instead of at garbage collection). */
export function release(...cs: (HTMLCanvasElement | null | undefined)[]) {
  for (const c of cs) {
    if (!c) continue;
    c.width = 0;
    c.height = 0;
  }
}
