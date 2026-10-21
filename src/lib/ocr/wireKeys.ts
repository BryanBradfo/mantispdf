/**
 * The keys of the OCR text layer wire contract with `crates/mantis-wasm/src/ocr/binding.rs`, for
 * the tests (ocrWire.test.ts checks them against the binding source, ocrWasm.test.ts against the
 * built engine). `read_pages` reads them all.
 */
export const PAGE_KEYS = ["page", "words"] as const;
/** What `result_to_js` writes. */
export const TEXT_LAYER_RESULT_KEYS = ["bytes", "alreadyOcrPages"] as const;
export const WORD_KEYS = ["text", "x", "y", "w", "h", "baseline", "spaceAfter", "angle"] as const;
