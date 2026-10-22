import { createContext, Fragment, use, useCallback, useContext, useMemo, type ReactNode } from "react";
import {
  Link as RouterLink,
  Navigate as RouterNavigate,
  useLocation,
  useNavigate,
  type LinkProps,
  type NavigateOptions,
  type NavigateProps,
  type To,
} from "react-router-dom";
import { DEFAULT_LOCALE, localeFromPath, localePath, type Locale } from "./locale";
import { en, type EnDictionary, type NamespaceName } from "./locales/en";
import { createT, splitRich } from "./translate";
import type { Dictionary, TagsOf, TArgs, TFunction } from "./types";

type AppDictionary = Dictionary<EnDictionary>;

/** Every non-default locale's lazy chunk. Adding a language = adding its loader here. */
const LOADERS: Record<Exclude<Locale, typeof DEFAULT_LOCALE>, () => Promise<AppDictionary>> = {
  fr: () => import("./locales/fr").then((m) => m.default),
};

const loading = new Map<Locale, Promise<AppDictionary>>();

/** Starts (once) and returns the load of a locale's dictionary. */
export function loadLocale(locale: Locale): Promise<AppDictionary> {
  if (locale === DEFAULT_LOCALE) return Promise.resolve(en);
  let p = loading.get(locale);
  if (!p) {
    p = LOADERS[locale]();
    loading.set(locale, p);
  }
  return p;
}

interface LocaleState {
  locale: Locale;
  dict: AppDictionary;
}

const LocaleContext = createContext<LocaleState>({ locale: DEFAULT_LOCALE, dict: en });

/**
 * Reads the locale from the URL (`/fr/...` is French) and provides its dictionary. A non-English
 * dictionary suspends on first use, so render this under a `<Suspense>` boundary.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = localeFromPath(useLocation().pathname);
  const dict = locale === DEFAULT_LOCALE ? en : use(loadLocale(locale));
  const value = useMemo(() => ({ locale, dict }), [locale, dict]);
  return <LocaleContext value={value}>{children}</LocaleContext>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext).locale;
}

/** `t` for one namespace: `const t = useT("merge"); t("title"); t("files", { count })`. */
export function useT<NS extends NamespaceName>(ns: NS): TFunction<EnDictionary[NS]> {
  const { locale, dict } = useContext(LocaleContext);
  return useMemo(() => createT(dict[ns], en[ns], locale), [dict, ns, locale]);
}

/** `localePath` bound to the current locale: `useLocalePath()("/merge")` -> `/fr/merge` under /fr. */
export function useLocalePath(): (path: string) => string {
  const locale = useLocale();
  return useCallback((path: string) => localePath(path, locale), [locale]);
}

function localizeTo(to: To, lp: (path: string) => string): To {
  if (typeof to === "string") return lp(to);
  return to.pathname ? { ...to, pathname: lp(to.pathname) } : to;
}

/** react-router `Link` that keeps the current locale prefix on absolute paths. */
export function Link({ to, ...rest }: LinkProps) {
  return <RouterLink to={localizeTo(to, useLocalePath())} {...rest} />;
}

/** react-router `Navigate` that keeps the current locale prefix. */
export function Navigate({ to, ...rest }: NavigateProps) {
  return <RouterNavigate to={localizeTo(to, useLocalePath())} {...rest} />;
}

/** `useNavigate` that keeps the current locale prefix on absolute paths. */
export function useLocaleNavigate(): (to: To, options?: NavigateOptions) => void {
  const navigate = useNavigate();
  const lp = useLocalePath();
  return useCallback(
    (to: To, options?: NavigateOptions) => void navigate(localizeTo(to, lp), options),
    [navigate, lp],
  );
}

type RichComponents<Tag extends string> = Record<Tag, (chunk: ReactNode) => ReactNode>;

/**
 * Renders a translated sentence whose `<tag>chunks</tag>` become elements, e.g.
 * `renderRich(t("help"), { link: (c) => <Link to="/merge">{c}</Link> })`.
 * A tag without a component renders as plain text.
 */
export function renderRich(text: string, components: Partial<RichComponents<string>>): ReactNode[] {
  return splitRich(text).map((chunk, i) => {
    if (typeof chunk === "string") return chunk;
    const wrap = components[chunk.tag];
    return <Fragment key={i}>{wrap ? wrap(chunk.text) : chunk.text}</Fragment>;
  });
}

type TransProps<NS extends NamespaceName, K extends keyof EnDictionary[NS] & string> = {
  ns: NS;
  k: K;
  /** One renderer per tag in the English message (`<link>` -> `link`). */
  components: RichComponents<TagsOf<EnDictionary[NS][K]>>;
} & (TArgs<EnDictionary[NS][K]> extends [] ? { values?: undefined } : { values: TArgs<EnDictionary[NS][K]>[0] });

/** `<Trans ns="merge" k="help" components={{ link: (c) => <Link to="/split">{c}</Link> }} />` */
export function Trans<NS extends NamespaceName, K extends keyof EnDictionary[NS] & string>(
  props: TransProps<NS, K>,
) {
  const t = useT(props.ns) as (key: string, params?: object) => string;
  return <>{renderRich(t(props.k, props.values), props.components)}</>;
}
