import type { Locale } from "./locale";
import type { NsT } from "./nsT";

type CommonT = NsT<"common">;

export interface DescribedError {
  /** Translated sentence to show. */
  message: string;
  /** Raw engine text for a `<details>` element when the error was not recognised. */
  details: string | null;
}

interface Known {
  pattern: RegExp;
  describe: (m: RegExpExecArray, t: CommonT) => string;
  /** Keep the raw engine text as details (it names what was refused). */
  details?: true;
}

/**
 * Known engine/worker error texts (English, from crates/mantis-wasm, the worker and the JS libs)
 * and their translated sentence. English shows the engine's own text (it is English already).
 */
const KNOWN: readonly Known[] = [
  { pattern: /^Wrong password$/, describe: (_, t) => t("errorWrongPassword") },
  {
    pattern: /^PDF (\d+) is password-protected\. Unlock it first\.$/,
    describe: (m, t) => t("errorLockedNth", { n: m[1] }),
  },
  {
    pattern: /^This PDF is password-protected\. Unlock it first\.$/,
    describe: (_, t) => t("errorLocked"),
  },
  // Worker failures (hooks/usePdfWorker) and browser image decoding (lib/imageInput).
  {
    pattern: /^Characters not supported by the standard PDF fonts: (.+)$/,
    describe: (m, t) => t("errorUnsupportedChars", { chars: m[1] }),
  },
  { pattern: /^PDF engine crashed$/, describe: (_, t) => t("errorEngineCrashed") },
  { pattern: /^PDF engine sent an unreadable message$/, describe: (_, t) => t("errorEngineUnreadable") },
  { pattern: /^Canvas is not available$/, describe: (_, t) => t("errorNoCanvas") },
  { pattern: /^Image decoding is not supported in this browser$/, describe: (_, t) => t("errorNoDecoder") },
  { pattern: /^Image is too large to decode \(limit 100 megapixels\)$/, describe: (_, t) => t("errorDecodeTooLarge") },
  // Engine (crates/mantis-wasm): reading and saving.
  { pattern: /^Failed to parse PDF (\d+): /, describe: (m, t) => t("errorParseNth", { n: m[1] }), details: true },
  { pattern: /^Failed to parse PDF: /, describe: (_, t) => t("errorParse"), details: true },
  { pattern: /^(No catalog|No Pages ref in catalog|Cannot access (base Pages|Pages node|Kids array)): /, describe: (_, t) => t("errorParse"), details: true },
  { pattern: /^Failed to (save PDF|compress content): /, describe: (_, t) => t("errorSave"), details: true },
  { pattern: /^The PDF has no pages$/, describe: (_, t) => t("errorNoPages") },
  { pattern: /^This PDF is not password-protected$/, describe: (_, t) => t("errorNotLocked") },
  // Page selection (split, extract, page plans, stamps).
  {
    pattern: /^Page (\d+) does not exist \(the document has (\d+) pages\)$/,
    describe: (m, t) => t("errorNoSuchPage", { page: m[1], count: Number(m[2]) }),
  },
  {
    pattern: /^Invalid range (\d+)[–-](\d+) for a (\d+)-page document$/,
    describe: (m, t) => t("errorBadRange", { start: m[1], end: m[2], count: Number(m[3]) }),
  },
  {
    pattern: /^(The result must contain at least one page from a document|Cannot create a PDF with zero pages)$/,
    describe: (_, t) => t("errorEmptyResult"),
  },
  { pattern: /^No documents to merge$/, describe: (_, t) => t("errorNoDocuments") },
  // Geometry, images, stamps, editor.
  {
    pattern: /^The crop area on page (\d+) is outside the page or smaller than 1 pt$/,
    describe: (m, t) => t("errorCropOutside", { page: m[1] }),
  },
  { pattern: /^Images are too large$/, describe: (_, t) => t("errorImagesTooLarge") },
  { pattern: /^Unsupported JPEG image/, describe: (_, t) => t("errorJpeg"), details: true },
  { pattern: /^Too many stamps$/, describe: (_, t) => t("errorTooManyStamps") },
  { pattern: /^Font size must be a positive number$/, describe: (_, t) => t("errorFontSize") },
  // Settings the engine refuses (edit, forms, redact, OCR, stamps, geometry, images, page plans).
  {
    pattern: /^(Invalid ([A-Za-z]+ )*settings|Invalid image placement|Invalid plan entry|Malformed page plan)/,
    describe: (_, t) => t("errorSettings"),
    details: true,
  },
  // Redaction (the engine refuses to save a file it could not verify).
  { pattern: /^Redaction verification failed on page (\d+)$/, describe: (m, t) => t("errorVerifyPage", { page: m[1] }) },
  { pattern: /^Redaction verification failed on the saved file$/, describe: (_, t) => t("errorVerifyFile") },
  // OCR (lib/ocr/engine) and the worker.
  { pattern: /^OCR engine could not start$/, describe: (_, t) => t("errorOcrNotStarted") },
  { pattern: /^(WASM engine not initialized|Worker not initialized)$/, describe: (_, t) => t("errorNotReady") },
];

/** An error whose message is already translated for the user: `describeError` shows it as it is. */
export class UserError extends Error {}

/** What an error alert shows: a plain message, or a described error with optional raw details. */
export type UiError = string | DescribedError;

/**
 * Maps a caught error to the message to show. English shows the error's own text (engine messages
 * are English already). Another locale gets the translated sentence of a known message (with the raw
 * text as details where it names what was refused), else a generic sentence with the raw text.
 */
export function describeError(err: unknown, t: CommonT, locale: Locale): DescribedError {
  if (err instanceof UserError) return { message: err.message, details: null };
  const raw = err instanceof Error ? err.message : String(err);
  if (locale === "en") return { message: raw, details: null };
  for (const { pattern, describe, details } of KNOWN) {
    const m = pattern.exec(raw);
    if (m) return { message: describe(m, t), details: details ? raw : null };
  }
  return { message: t("errorGeneric"), details: raw };
}

/**
 * The alert for an engine that failed to start (`usePdfWorker().initError`). English keeps
 * "WASM engine failed to load: <raw>"; another locale names a known failure in its words, or says the
 * engine failed with the raw text as details.
 */
export function describeInitError(raw: string | null, t: CommonT, locale: Locale): UiError | null {
  if (raw === null) return null;
  if (locale === "en") return t("engineFailed", { error: raw });
  const known = describeError(new Error(raw), t, locale);
  return known.message !== t("errorGeneric")
    ? { message: t("engineFailed", { error: known.message }), details: known.details }
    : { message: t("engineFailedNoDetail"), details: raw };
}
