import type { Locale } from "./locale";
import type { MessageValue, Messages, Namespace, ParamValue, PluralForms, TFunction } from "./types";

/** Replaces `{name}` placeholders; a placeholder without a param stays visible. */
export function interpolate(template: string, params?: Readonly<Record<string, ParamValue>>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

/** Picks the plural form for `count` under the locale's CLDR rules, falling back to `other`. */
export function selectPlural(forms: PluralForms, count: number, locale: Locale): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return forms[rules.select(count)] ?? forms.other;
}

function resolve(value: MessageValue, locale: Locale, params?: Record<string, ParamValue>): string {
  if (typeof value === "string") return interpolate(value, params);
  const count = typeof params?.count === "number" ? params.count : 0;
  const formatted = { ...params, count: new Intl.NumberFormat(locale).format(count) };
  return interpolate(selectPlural(value, count, locale), formatted);
}

/**
 * Builds `t` for one namespace. `fallback` is the English namespace, used for a key that a
 * lazily loaded dictionary lacks at runtime (the type system already forbids it at build time).
 */
export function createT<N extends Namespace>(
  messages: Messages<N>,
  fallback: N,
  locale: Locale,
): TFunction<N> {
  const own: Partial<Record<string, MessageValue>> = messages;
  return ((key: string, params?: Record<string, ParamValue>) => {
    const value = own[key] ?? fallback[key];
    // Unreachable with typed keys; shows the key instead of crashing if a cast slipped through.
    return value === undefined ? key : resolve(value, locale, params);
  }) as TFunction<N>;
}

export type RichChunk = string | { tag: string; text: string };

/** Splits `a <link>b</link> c` into text and tagged chunks (one level, no nesting). */
export function splitRich(text: string): RichChunk[] {
  const chunks: RichChunk[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) chunks.push(text.slice(last, m.index));
    chunks.push({ tag: m[1], text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length || chunks.length === 0) chunks.push(text.slice(last));
  return chunks;
}
