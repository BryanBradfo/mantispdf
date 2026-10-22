/** Plural forms keyed by `Intl.PluralRules` category; `other` is the required fallback. */
export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** A message is either a string or a set of plural forms selected by `count`. */
export type MessageValue = string | PluralForms;

/** One namespace (`common`, `merge`, ...): flat keys to messages. */
export type Namespace = Readonly<Record<string, MessageValue>>;

/**
 * The shape every non-English namespace must satisfy, derived from the English source
 * (`Messages<typeof en.merge>`): same keys, any wording, any plural categories.
 * A missing or extra key is a compile error.
 */
export type Messages<N extends Namespace> = {
  [K in keyof N]: N[K] extends string ? string : PluralForms;
};

/** A whole locale: every namespace of the English dictionary `D`. */
export type Dictionary<D extends Record<string, Namespace>> = { [NS in keyof D]: Messages<D[NS]> };

/** Values that can be interpolated into a `{name}` placeholder. */
export type ParamValue = string | number;

type Placeholders<S> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;

type PlaceholdersOf<V> = V extends string
  ? Placeholders<V>
  : { [K in keyof V]-?: Placeholders<V[K]> }[keyof V];

/** Names of `<tag>...</tag>` chunks in a message (used by `Trans` / `renderRich`). */
export type Tags<S> = S extends `${string}<${infer T}>${infer Rest}`
  ? T extends `/${string}`
    ? Tags<Rest>
    : T | Tags<Rest>
  : never;

export type TagsOf<V> = V extends string ? Tags<V> : { [K in keyof V]-?: Tags<V[K]> }[keyof V];

/** The params argument `t(key, ...)` requires for message `V`. */
export type TArgs<V> = V extends string
  ? [Placeholders<V>] extends [never]
    ? []
    : [params: Record<Placeholders<V>, ParamValue>]
  : [params: { count: number } & Record<Exclude<PlaceholdersOf<V>, "count">, ParamValue>];

/** `t` for namespace `N`: typed keys, typed params. */
export type TFunction<N extends Namespace> = <K extends keyof N & string>(
  key: K,
  ...args: TArgs<N[K]>
) => string;
