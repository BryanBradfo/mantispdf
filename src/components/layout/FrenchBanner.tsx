import { useEffect, useState } from "react";
import { Link as RouterLink, useLocation } from "react-router-dom";
import { loadLocale, localePath, readStoredLocale, shouldOfferFrench, storeLocale, useLocale, useT } from "../../i18n";

function browserLanguages(): readonly string[] {
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/**
 * "Version française disponible" for a French browser on an English page with no stored choice.
 * Never redirects (URLs stay stable for search engines and shared links); following or dismissing
 * it stores the choice, so it shows once.
 */
export default function FrenchBanner() {
  const t = useT("common");
  const locale = useLocale();
  const { pathname, search, hash } = useLocation();
  const [offered, setOffered] = useState(() =>
    shouldOfferFrench({ locale, stored: readStoredLocale(), languages: browserLanguages() }),
  );
  const show = offered && locale === "en";

  useEffect(() => {
    if (show) void loadLocale("fr");
  }, [show]);

  if (!show) return null;
  return (
    <div
      lang="fr"
      role="region"
      aria-label={t("bannerFrench")}
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-mantis-200 bg-mantis-50 px-4 py-2 text-sm text-gray-700 dark:border-[#1a1a1a] dark:bg-[#0f1a0f] dark:text-[#aaa]"
    >
      <span>{t("bannerFrench")}</span>
      <RouterLink
        to={localePath(pathname + search + hash, "fr")}
        onClick={() => storeLocale("fr")}
        className="font-medium text-mantis-700 underline dark:text-mantis-400"
      >
        {t("bannerFrenchLink")}
      </RouterLink>
      <button
        type="button"
        onClick={() => {
          storeLocale("en");
          setOffered(false);
        }}
        className="text-gray-500 underline hover:text-gray-700 dark:text-[#555] dark:hover:text-[#888]"
      >
        {t("bannerFrenchDismiss")}
      </button>
    </div>
  );
}
