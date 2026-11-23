/** The pdf.js worker, copied to public/ by scripts/copy-pdf-worker.mjs. */
export const PDF_WORKER_FILE = "pdf.worker.min.mjs";

/**
 * Its root-relative URL, versioned by the pdf.js API version: a deploy that bumps pdfjs-dist changes the URL,
 * so a page never meets an older worker kept by the service worker's precache or the HTTP cache ("API version
 * does not match Worker version"). The precache entry uses the same URL (src/pwa/config.ts).
 */
export const pdfWorkerPath = (pdfjsVersion: string): string => `/${PDF_WORKER_FILE}?v=${pdfjsVersion}`;
