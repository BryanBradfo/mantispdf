// Copy the pdf.js worker from the installed pdfjs-dist into public/ so it is
// served as a stable static module file. This avoids both the production
// "fake worker" fallback (workerSrc to a bundled URL) and the "worker is being
// destroyed" crash (a single shared workerPort across multiple <Document>s).
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url));
const destDir = fileURLToPath(new URL("../public", import.meta.url));
mkdirSync(destDir, { recursive: true });
copyFileSync(src, `${destDir}/pdf.worker.min.mjs`);
// pdf.js is Apache-2.0: its licence is served next to the worker.
copyFileSync(fileURLToPath(new URL("../node_modules/pdfjs-dist/LICENSE", import.meta.url)), `${destDir}/pdf.worker.min.mjs.LICENSE`);
console.log("Copied pdf.js worker and its licence to public/");
