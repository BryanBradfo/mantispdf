export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE = "en" satisfies Locale;

/** Locales served under a `/<locale>` prefix (every locale but the default). */
const PREFIXED: readonly Locale[] = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

function isLocale(s: string): s is Locale {
  return (LOCALES as readonly string[]).includes(s);
}

/**
 * Collapses a leading run of `/` and `\` into one `/`. Browsers read `//host` and `/\host` (and
 * `\\host`) as protocol-relative URLs, so a path that kept them would link off-site (open redirect).
 */
function collapseLeadingSlashes(path: string): string {
  return asBrowserReads(path).replace(/^[/\\]+/, "/");
}

/** What a browser's URL parser keeps: tabs and newlines dropped anywhere, leading C0 controls and spaces trimmed. */
function asBrowserReads(path: string): string {
  return path.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
}

function isAbsolute(path: string): boolean {
  const p = asBrowserReads(path);
  return p.startsWith("/") || p.startsWith("\\");
}

/** First path segment, e.g. `fr` for `/fr/merge?x`. */
function firstSegment(path: string): string {
  return /^\/([^/?#]*)/.exec(path)?.[1] ?? "";
}

/** The locale a path belongs to: `/fr/...` is French, anything else English. */
export function localeFromPath(pathname: string): Locale {
  const seg = firstSegment(collapseLeadingSlashes(pathname));
  return isLocale(seg) && PREFIXED.includes(seg) ? seg : DEFAULT_LOCALE;
}

/**
 * Removes the locale prefix: `/fr/merge` -> `/merge`, `/fr` -> `/`. An absolute result always
 * starts with exactly one `/` (never `//` or `/\`).
 */
export function stripLocale(path: string): string {
  if (!isAbsolute(path)) return path;
  const p = collapseLeadingSlashes(path);
  if (localeFromPath(p) === DEFAULT_LOCALE) return p;
  return collapseLeadingSlashes(`/${p.slice(1 + firstSegment(p).length)}`);
}

/**
 * The URL of an app path in `locale`: `/merge` -> `/fr/merge`, `/` -> `/fr`. Accepts an already
 * prefixed path (so it also switches locales) and keeps `?query#hash`. Relative paths pass through.
 * Never returns a protocol-relative value.
 */
export function localePath(path: string, locale: Locale): string {
  if (!isAbsolute(path)) return path;
  const bare = stripLocale(path);
  if (locale === DEFAULT_LOCALE) return bare;
  const cut = bare.search(/[?#]/);
  const pathname = cut < 0 ? bare : bare.slice(0, cut);
  const suffix = cut < 0 ? "" : bare.slice(cut);
  return (pathname === "/" ? `/${locale}` : `/${locale}${pathname}`) + suffix;
}

/** The route table followed by its copy under every prefixed locale (`*` becomes `/fr/*`). */
export function localizeRoutes<R extends { path: string }>(routes: readonly R[]): R[] {
  return [
    ...routes,
    ...PREFIXED.flatMap((locale) =>
      routes.map((r) => ({ ...r, path: r.path === "*" ? `/${locale}/*` : localePath(r.path, locale) })),
    ),
  ];
}
