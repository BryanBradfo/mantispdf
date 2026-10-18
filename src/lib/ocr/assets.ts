/**
 * The OCR runtime files served from the app origin under `/ocr/`, copied there from
 * node_modules by `scripts/copy-ocr-assets.mjs` (which keeps its own copy of this list;
 * assets.test.ts checks they agree). Nothing is ever fetched from a CDN.
 */
import { OCR_LANGUAGES, type OcrLanguage } from "./languages";

export const OCR_BASE = "/ocr";
/** tesseract.js worker script. */
export const OCR_WORKER_FILE = "worker.min.js";
/**
 * tesseract.js-core builds for `OEM.LSTM_ONLY`; the worker picks one by WebAssembly feature
 * detection (relaxed SIMD, else SIMD, else plain). Each embeds its wasm.
 */
export const OCR_CORE_FILES = ["tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"] as const;

export function ocrLanguageFile(code: OcrLanguage): string {
  return `${code}.traineddata.gz`;
}

/** Every file under `/ocr/` the engine may request, relative to it. */
export function ocrAssetFiles(): string[] {
  return [OCR_WORKER_FILE, ...OCR_CORE_FILES.map((f) => `core/${f}`), ...OCR_LANGUAGES.map((l) => `lang/${ocrLanguageFile(l.code)}`)];
}
