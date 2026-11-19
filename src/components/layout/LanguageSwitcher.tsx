import { Link as RouterLink, useLocation } from "react-router-dom";
import { LOCALES, loadLocale, localePath, storeLocale, useLocale, useT, type Locale } from "../../i18n";
import { focusRing } from "../../pages/ToolShell";

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
    <nav aria-label={t("language")} className="flex items-center font-display text-[13px] uppercase tracking-[0.14em]">
      {LOCALES.map((l, i) => (
        <span key={l} className="flex items-center">
          {i > 0 && (
            <span aria-hidden="true" className="px-1.5 text-ink-3">
              /
            </span>
          )}
          <RouterLink
            to={{ pathname: localePath(pathname, l), search, hash }}
            lang={l}
            hrefLang={l}
            aria-label={names[l]}
            aria-current={l === locale ? "true" : undefined}
            onClick={() => storeLocale(l)}
            onMouseEnter={() => void loadLocale(l)}
            onFocus={() => void loadLocale(l)}
            className={`px-0.5 py-1 ${l === locale ? "text-ink underline decoration-1 underline-offset-[6px]" : "text-ink-2 hover:text-ink"} ${focusRing}`}
          >
            {l.toUpperCase()}
          </RouterLink>
        </span>
      ))}
    </nav>
  );
}
