/**
 * The keys of the redact wire contract with `crates/mantis-wasm/src/redact/binding.rs`, for the
 * tests (redactWire.test.ts checks them against the binding source, redactWasm.test.ts against
 * the built engine). `read_rects` / `read_job` read the first four; `plan_to_js` /
 * `result_to_js` write the last two.
 */
export const RECT_KEYS = ["page", "rect"] as const;
export const JOB_KEYS = ["rects", "fill", "removeMetadata", "rasters"] as const;
export const RASTER_KEYS = ["page", "width", "height", "dpi", "rgba"] as const;
export const FILLS = ["black", "white"] as const;
export const PLAN_KEYS = ["page", "reason"] as const;
export const RESULT_KEYS = [
  "bytes",
  "pagesRedacted",
  "pagesRasterized",
  "glyphsRemoved",
  "pathsRemoved",
  "imagesRedacted",
  "imagesRemoved",
  "formsRedacted",
  "annotationsRemoved",
] as const;
/** `redact_search`: its options and what it returns. */
export const SEARCH_OPTION_KEYS = ["wholeWord", "caseSensitive"] as const;
export const SEARCH_KEYS = ["pages", "undecodablePages"] as const;
export const SEARCH_PAGE_KEYS = ["page", "quads"] as const;
