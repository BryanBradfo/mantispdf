import type { EnDictionary } from "./locales/en";
import type { TFunction } from "./types";

type CommonT = TFunction<EnDictionary["common"]>;

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

/** Maps a caught error to a translated message; unknown errors get a generic one plus raw details. */
export function describeError(err: unknown, t: CommonT): DescribedError {
  const raw = err instanceof Error ? err.message : String(err);
  for (const { pattern, describe } of KNOWN) {
    const m = pattern.exec(raw);
    if (m) return { message: describe(m, t), details: null };
  }
  return { message: t("errorGeneric"), details: raw };
}
