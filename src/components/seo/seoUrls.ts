import { LOCALES, localePath, type Locale } from "../../i18n";

export const SITE = "https://mantispdf.vercel.app";

const OG_LOCALE: Record<Locale, string> = { en: "en_US", fr: "fr_FR" };

function absolute(path: string): string {
  return path === "/" ? `${SITE}/` : `${SITE}${path}`;
}

/** Canonical URL for `path` (English form, e.g. `/merge`) in `locale`, plus hreflang alternates. */
export function seoUrls(path: string, locale: Locale) {
  return {
    canonical: absolute(localePath(path, locale)),
    alternates: [
      ...LOCALES.map((l) => ({ hrefLang: l as string, href: absolute(localePath(path, l)) })),
      { hrefLang: "x-default", href: absolute(localePath(path, "en")) },
    ],
    ogLocale: OG_LOCALE[locale],
  };
}
