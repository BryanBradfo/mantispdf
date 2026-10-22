import { DEFAULT_LOCALE, LOCALES, localeFromPath, type Locale } from "./locale";

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

/**
 * The locale to render: the `/fr` prefix wins; an unprefixed path uses `stored` (pass the stored
 * choice only where it should apply, i.e. the desktop app), else English.
 */
export function resolveLocale(pathname: string, stored: Locale | null): Locale {
  const fromPath = localeFromPath(pathname);
  return fromPath !== DEFAULT_LOCALE ? fromPath : (stored ?? DEFAULT_LOCALE);
}
