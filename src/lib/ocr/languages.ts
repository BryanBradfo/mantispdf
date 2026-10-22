/**
 * The OCR languages offered (Latin script, tesseract `best_int` models self-hosted under
 * `/ocr/lang/`), and the default selection.
 */
export const OCR_LANGUAGES = [
  { code: "eng", label: "English", bcp47: "en" },
  { code: "fra", label: "French", bcp47: "fr" },
  { code: "deu", label: "German", bcp47: "de" },
  { code: "spa", label: "Spanish", bcp47: "es" },
  { code: "ita", label: "Italian", bcp47: "it" },
  { code: "por", label: "Portuguese", bcp47: "pt" },
  { code: "nld", label: "Dutch", bcp47: "nl" },
] as const;

export type OcrLanguage = (typeof OCR_LANGUAGES)[number]["code"];

/** The language's name in the UI language (`Intl.DisplayNames`), capitalised; the English label as a fallback. */
export function languageLabel(code: OcrLanguage, locale: string): string {
  const lang = OCR_LANGUAGES.find((l) => l.code === code);
  if (!lang) return code;
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(lang.bcp47);
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : lang.label;
  } catch {
    return lang.label;
  }
}

/**
 * English, plus the first of the browser's languages (`navigator.languages`) that is offered
 * and is not English.
 */
export function defaultLanguages(browser: readonly string[]): OcrLanguage[] {
  for (const tag of browser) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary === "en") break;
    const found = OCR_LANGUAGES.find((l) => l.bcp47 === primary);
    if (found) return ["eng", found.code];
  }
  return ["eng"];
}
