import { LOCALES, type Locale } from "./locale";

const KEY = "locale";

/** The language the visitor picked with the switcher or the banner, if any. */
export function readStoredLocale(): Locale | null {
  try {
    const v = localStorage.getItem(KEY);
    return v !== null && (LOCALES as readonly string[]).includes(v) ? (v as Locale) : null;
  } catch {
    return null;
  }
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    // Storage blocked (private mode): the choice simply is not remembered.
  }
}

/** Show the "Version française disponible" banner: English page, French browser, no choice yet. */
export function shouldOfferFrench(opts: {
  locale: Locale;
  stored: Locale | null;
  languages: readonly string[];
}): boolean {
  const first = opts.languages[0]?.toLowerCase() ?? "";
  return opts.locale === "en" && opts.stored === null && (first === "fr" || first.startsWith("fr-"));
}
