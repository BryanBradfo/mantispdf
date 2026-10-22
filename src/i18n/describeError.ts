import type { Locale } from "./locale";
import type { NsT } from "./nsT";

type CommonT = NsT<"common">;

export interface DescribedError {
  /** Translated sentence to show. */
  message: string;
  /** Raw engine text for a `<details>` element when the error was not recognised. */
  details: string | null;
}

/** Known engine/worker error texts (English, from Rust or JS) and their translated sentence. */
const KNOWN: readonly { pattern: RegExp; describe: (m: RegExpExecArray, t: CommonT) => string }[] = [
  { pattern: /^Wrong password$/, describe: (_, t) => t("errorWrongPassword") },
  {
    pattern: /^PDF (\d+) is password-protected\. Unlock it first\.$/,
    describe: (m, t) => t("errorLockedNth", { n: m[1] }),
  },
  {
    pattern: /^This PDF is password-protected\. Unlock it first\.$/,
    describe: (_, t) => t("errorLocked"),
  },
];

/** An error whose message is already translated for the user: `describeError` shows it as it is. */
export class UserError extends Error {}

/** What an error alert shows: a plain message, or a described error with optional raw details. */
export type UiError = string | DescribedError;

/**
 * Maps a caught error to a translated message. An unknown error keeps its own text in English (it is
 * English already); in another locale it gets a generic sentence with the raw text as details.
 */
export function describeError(err: unknown, t: CommonT, locale: Locale): DescribedError {
  if (err instanceof UserError) return { message: err.message, details: null };
  const raw = err instanceof Error ? err.message : String(err);
  for (const { pattern, describe } of KNOWN) {
    const m = pattern.exec(raw);
    if (m) return { message: describe(m, t), details: null };
  }
  return locale === "en" ? { message: raw, details: null } : { message: t("errorGeneric"), details: raw };
}
