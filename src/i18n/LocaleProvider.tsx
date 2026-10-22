import { createContext, Fragment, use, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
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
import { DEFAULT_LOCALE, localePath, type Locale } from "./locale";
import { readStoredLocale, resolveLocale } from "./localeChoice";
import { en, type EnDictionary, type NamespaceName } from "./locales/en";
import { createT, splitRich } from "./translate";
import type { Dictionary, TagsOf, TArgs, TFunction } from "./types";

type AppDictionary = Dictionary<EnDictionary>;

/** Every non-default locale's lazy chunk. Adding a language = adding its loader here. */
const LOADERS: Record<Exclude<Locale, typeof DEFAULT_LOCALE>, () => Promise<AppDictionary>> = {
  fr: () => import("./locales/fr/fr").then((m) => m.default),
};

/** A promise React's `use()` can read synchronously once settled (the documented thenable fields). */
type TrackedPromise<T> = Promise<T> & { status?: "fulfilled"; value?: T };

function track<T>(p: Promise<T>): Promise<T> {
  const tracked: TrackedPromise<T> = p;
  tracked.then(
    (value) => {
      tracked.status = "fulfilled";
      tracked.value = value;
    },
    () => {},
  );
  return tracked;
}

/** Loads in flight or done. A failed load is removed so the next call tries again. */
const loading = new Map<Locale, Promise<AppDictionary>>();
/** Dictionaries already loaded: a render reads them synchronously (no suspend after a preload). */
const loaded = new Map<Locale, AppDictionary>();

/** Starts (once) and returns the load of a locale's dictionary. Call it early (switcher hover, banner). */
export function loadLocale(locale: Locale): Promise<AppDictionary> {
  if (locale === DEFAULT_LOCALE) return Promise.resolve(en);
  let p = loading.get(locale);
  if (!p) {
    p = LOADERS[locale]().then(
      (dict) => {
        loaded.set(locale, dict);
        return dict;
      },
      (err: unknown) => {
        loading.delete(locale);
        throw err;
      },
    );
    loading.set(locale, p);
  }
  return p;
}

interface Settled {
  dict: AppDictionary;
  failed: boolean;
}

/**
 * What a render waits for: the dictionary, or English plus `failed` when the chunk cannot load.
 * Never rejects, so a failure never reaches an error boundary. Kept until `retry` so a failing
 * network does not loop.
 */
const settling = new Map<Locale, Promise<Settled>>();

function settle(locale: Locale): Promise<Settled> {
  let p = settling.get(locale);
  if (!p) {
    p = track(
      loadLocale(locale).then(
        (dict) => ({ dict, failed: false }),
        () => ({ dict: en, failed: true }),
      ),
    );
    settling.set(locale, p);
  }
  return p;
}

interface LocaleState {
  locale: Locale;
  dict: AppDictionary;
}

const LocaleContext = createContext<LocaleState>({ locale: DEFAULT_LOCALE, dict: en });

function LoadFailedNotice({ onRetry }: { onRetry: () => void }) {
  const t = createT(en.common, en.common, DEFAULT_LOCALE);
  return (
    <div
      role="status"
      className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
    >
      {t("localeLoadFailed")}{" "}
      <button type="button" onClick={onRetry} className="font-medium underline">
        {t("retry")}
      </button>
    </div>
  );
}

/**
 * Provides the locale and its dictionary. The `/fr` prefix decides; on the desktop app (Tauri) an
 * unprefixed path uses the stored choice. A non-English dictionary suspends on first use (render
 * this under `<Suspense>`); if its chunk fails, the page shows in English with a retry notice.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const pathname = useLocation().pathname;
  const locale = resolveLocale(pathname, isTauri() ? readStoredLocale() : null);
  const [, setAttempt] = useState(0);
  const ready = locale === DEFAULT_LOCALE ? en : loaded.get(locale);
  const { dict, failed } = ready ? { dict: ready, failed: false } : use(settle(locale));
  const value = useMemo(() => ({ locale, dict }), [locale, dict]);
  const retry = useCallback(() => {
    settling.delete(locale);
    setAttempt((n) => n + 1);
  }, [locale]);
  return (
    <LocaleContext value={value}>
      {failed && <LoadFailedNotice onRetry={retry} />}
      {children}
    </LocaleContext>
  );
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

type TransMessage<NS extends NamespaceName, K extends keyof EnDictionary[NS]> = EnDictionary[NS][K];

type TransProps<NS extends NamespaceName, K extends keyof EnDictionary[NS] & string> = {
  ns: NS;
  k: K;
} & ([TagsOf<TransMessage<NS, K>>] extends [never]
  ? { components?: undefined }
  : {
      /** One renderer per tag in the English message (`<link>` -> `link`). */
      components: RichComponents<TagsOf<TransMessage<NS, K>>>;
    }) &
  (TArgs<TransMessage<NS, K>> extends [] ? { values?: undefined } : { values: TArgs<TransMessage<NS, K>>[0] });

/**
 * A translated sentence with inline elements:
 * `<Trans ns="merge" k="help" components={{ link: (c) => <Link to="/split">{c}</Link> }} />`.
 */
export function Trans<NS extends NamespaceName, K extends keyof EnDictionary[NS] & string>(
  props: TransProps<NS, K>,
) {
  const t = useT(props.ns) as (key: string, params?: object) => string;
  const components: Partial<RichComponents<string>> = props.components ?? {};
  return <>{renderRich(t(props.k, props.values), components)}</>;
}
