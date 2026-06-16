// Single entry point for react-pdf that pins the pdf.js worker URL.
//
// Symptom (production only): every PDF failed with "Failed to load PDF file." and
// the console warned "Setting up fake worker" / "Failed to resolve module
// specifier 'pdf.worker.mjs'". It worked in `npm run dev` but not in the built
// app — so it was invisible until deployed.
//
// Cause: react-pdf's own index.js runs `pdfjs.GlobalWorkerOptions.workerSrc =
// 'pdf.worker.mjs'` (a bare specifier) unconditionally at module load. In the
// production bundle's module eval order, that ran AFTER our configuration and
// clobbered it back to the bare default, which pdf.js can't resolve → it falls
// back to a broken main-thread "fake worker".
//
// Fix: pin our worker URL with a non-writable property so react-pdf's reset is a
// no-op. The worker file itself is served from public/ (copied by
// scripts/copy-pdf-worker.mjs via the pre{dev,build} hooks) as a stable,
// same-origin module the <Document>s can spawn as a real worker. Every react-pdf
// consumer imports through this module so the pin is always in effect.
import { pdfjs, Document, Page, Thumbnail, Outline } from "react-pdf";

// react-pdf's own index.js unconditionally runs `GlobalWorkerOptions.workerSrc =
// 'pdf.worker.mjs'` (a bare specifier) at module load, which clobbers our value
// and makes pdf.js fall back to a broken main-thread "fake worker" in production.
// Pin our worker URL with a defineProperty whose setter ignores later writes, so
// react-pdf's reset becomes a no-op. Use a fully-qualified URL (pdf.js runs
// `new URL(workerSrc)` internally, which throws on a root-relative path).
const WORKER_SRC = new URL("/pdf.worker.min.mjs", window.location.origin).href;
Object.defineProperty(pdfjs.GlobalWorkerOptions, "workerSrc", {
  get: () => WORKER_SRC,
  set: () => {
    /* ignore react-pdf's default reset */
  },
  configurable: true,
});

export { pdfjs, Document, Page, Thumbnail, Outline };
