import { pdfjs } from "../pdf";
import type { Renderer } from "./types";

const MAX_DPR = 2;

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    // Browsers that cannot encode WebP fall back to PNG on their own.
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))), "image/webp", 0.8),
  );
}

export const pdfjsRenderer: Renderer = {
  async open(bytes) {
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    return {
      async render(pageNumber, width, mode) {
        const page = await pdf.getPage(pageNumber);
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width * dpr) / base.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("2D canvas unavailable");
        try {
          // ENABLE_FORMS leaves form widgets to an HTML layer (here: none), so their appearances
          // are not painted; every other annotation still is.
          const annotationMode = mode === "no-widgets" ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE;
          await page.render({ canvasContext: ctx, viewport, annotationMode }).promise;
          return await canvasToBlob(canvas);
        } finally {
          page.cleanup();
          canvas.width = 0; // release the backing store immediately
          canvas.height = 0;
        }
      },
      destroy() {
        void pdf.destroy();
      },
    };
  },
};
