// Copy the OCR runtime (tesseract.js worker, tesseract.js-core LSTM builds, language models)
// from node_modules into public/ocr/ so it is served from the app origin: tesseract.js
// would otherwise fetch all of it from a CDN. The file list mirrors src/lib/ocr/assets.ts
// (src/lib/ocr/assets.test.ts checks they agree).
//
//   node scripts/copy-ocr-assets.mjs            copy into public/ocr (pre{dev,build} hook)
//   node scripts/copy-ocr-assets.mjs --check D  fail unless D/ocr holds every file (postbuild)
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

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const check = process.argv.indexOf("--check");
  if (check !== -1) {
    const dir = join(root, process.argv[check + 1] ?? "dist", "ocr");
    const missing = OCR_FILES.filter((f) => !existsSync(join(dir, f)) || statSync(join(dir, f)).size === 0);
    if (missing.length) {
      console.error(`Missing OCR assets in ${dir}: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log(`All ${OCR_FILES.length} OCR assets present in ${dir}`);
    return;
  }
  const dest = join(root, "public/ocr");
  let bytes = 0;
  for (const [rel, src] of Object.entries(ocrSources(root))) {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(src, to);
    bytes += statSync(to).size;
  }
  console.log(`Copied ${OCR_FILES.length} OCR assets to public/ocr (${(bytes / 1e6).toFixed(1)} MB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
