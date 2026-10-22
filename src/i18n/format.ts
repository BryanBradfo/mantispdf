import type { Locale } from "./locale";

export function formatNumber(n: number, locale: Locale, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(n);
}

/** Size units per locale; French uses octets and a non-breaking space before the unit. */
const BYTE_UNITS: Record<Locale, { kb: string; mb: string; sep: string }> = {
  en: { kb: "KB", mb: "MB", sep: " " },
  fr: { kb: "Ko", mb: "Mo", sep: " " },
};

/** File size as KB (whole) below 1 MB, else MB with one decimal. English matches the pre-i18n output. */
export function formatBytes(n: number, locale: Locale): string {
  const { kb, mb, sep } = BYTE_UNITS[locale];
  if (n >= 1024 * 1024) {
    const v = formatNumber(n / 1024 / 1024, locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      useGrouping: false,
    });
    return `${v}${sep}${mb}`;
  }
  return `${formatNumber(n / 1024, locale, { maximumFractionDigits: 0, useGrouping: false })}${sep}${kb}`;
}
