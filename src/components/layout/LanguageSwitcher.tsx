import { Link as RouterLink, useLocation } from "react-router-dom";
import { LOCALES, loadLocale, localePath, storeLocale, useLocale, useT, type Locale } from "../../i18n";

/**
 * EN / FR switch: the same page under the other prefix (query and hash kept). Remembers the
 * choice, and starts loading the target dictionary on hover or focus so the switch does not flash.
 */
export default function LanguageSwitcher() {
  const t = useT("common");
  const locale = useLocale();
  const { pathname, search, hash } = useLocation();
  const names: Record<Locale, string> = { en: t("languageEnglish"), fr: t("languageFrench") };

  return (
    <nav
      aria-label={t("language")}
      className="flex overflow-hidden rounded-lg border border-gray-200 text-xs font-semibold dark:border-[#1a1a1a]"
    >
      {LOCALES.map((l) => (
        <RouterLink
          key={l}
          to={{ pathname: localePath(pathname, l), search, hash }}
          lang={l}
          hrefLang={l}
          aria-label={names[l]}
          aria-current={l === locale ? "true" : undefined}
          onClick={() => storeLocale(l)}
          onMouseEnter={() => void loadLocale(l)}
          onFocus={() => void loadLocale(l)}
          className={`px-2 py-1.5 transition ${
            l === locale
              ? "bg-mantis-600 text-white"
              : "bg-gray-50 text-gray-500 hover:bg-gray-100 dark:bg-[#141414] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
          }`}
        >
          {l.toUpperCase()}
        </RouterLink>
      ))}
    </nav>
  );
}
