// Copy the OCR runtime (tesseract.js worker, tesseract.js-core LSTM builds, language models)
// from node_modules into public/ocr/ so it is served from the app origin: tesseract.js
// would otherwise fetch all of it from a CDN. The file list mirrors src/lib/ocr/assets.ts
// (src/lib/ocr/assets.test.ts checks they agree).
//
//   node scripts/copy-ocr-assets.mjs            copy into public/ocr (pre{dev,build} hook)
//   node scripts/copy-ocr-assets.mjs --check D  fail unless D holds every OCR file, their licences
//                                               and the pdf.js worker's licence (postbuild)
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE = ["tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"];
const LANGS = ["eng", "fra", "deu", "spa", "ita", "por", "nld"];

/** Destination (relative to public/ocr) to source (absolute), for the project at `root`. */
export function ocrSources(root) {
  const nm = join(root, "node_modules");
  const map = { "worker.min.js": join(nm, "tesseract.js/dist/worker.min.js") };
  for (const f of CORE) map[`core/${f}`] = join(nm, "tesseract.js-core", f);
  // LSTM-only integer models (what tesseract.js itself uses for OEM.LSTM_ONLY).
  for (const l of LANGS) map[`lang/${l}.traineddata.gz`] = join(nm, `@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`);
  return map;
}

export const OCR_FILES = Object.keys(ocrSources("/"));

/** Licence files and the notice copied next to the runtime: destination to source. */
export function ocrLicenseSources(root) {
  const nm = join(root, "node_modules");
  return {
    "NOTICE.md": join(root, "scripts/ocr-NOTICE.md"),
    "tesseract.js.LICENSE.md": join(nm, "tesseract.js/LICENSE.md"),
    "worker.min.js.LICENSE.txt": join(nm, "tesseract.js/dist/worker.min.js.LICENSE.txt"),
    "core/LICENSE": join(nm, "tesseract.js-core/LICENSE"),
  };
}

export const OCR_LICENSE_FILES = Object.keys(ocrLicenseSources("/"));

/** The pdf.js worker's licence, copied by copy-pdf-worker.mjs (relative to the build root). */
const PDF_LICENSE = "pdf.worker.min.mjs.LICENSE";

/** Files the build output `dist` lacks (or has empty), relative to it. */
export function missingInDist(dist) {
  const required = [PDF_LICENSE, ...[...OCR_FILES, ...OCR_LICENSE_FILES].map((f) => `ocr/${f}`)];
  return required.filter((f) => !existsSync(join(dist, f)) || statSync(join(dist, f)).size === 0);
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const check = process.argv.indexOf("--check");
  if (check !== -1) {
    const dist = join(root, process.argv[check + 1] ?? "dist");
    const missing = missingInDist(dist);
    if (missing.length) {
      console.error(`Missing in ${dist}: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log(`All OCR assets, their licences and the pdf.js licence are present in ${dist}`);
    return;
  }
  const dest = join(root, "public/ocr");
  let bytes = 0;
  for (const [rel, src] of Object.entries({ ...ocrSources(root), ...ocrLicenseSources(root) })) {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(src, to);
    bytes += statSync(to).size;
  }
  console.log(`Copied ${OCR_FILES.length} OCR assets and their licences to public/ocr (${(bytes / 1e6).toFixed(1)} MB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
