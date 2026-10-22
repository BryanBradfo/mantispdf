// Test-only helpers (never imported by app code, so the French chunk stays lazy in the build).
import type { Locale } from "./locale";
import { en, type EnDictionary, type NamespaceName } from "./locales/en";
import fr from "./locales/fr/fr";
import { createT } from "./translate";
import type { Messages, TFunction } from "./types";

/** A synchronous `t` for one namespace, as the app would build it. */
export function tFor<NS extends NamespaceName>(ns: NS, locale: Locale = "en"): TFunction<EnDictionary[NS]> {
  const messages = (locale === "en" ? en[ns] : fr[ns]) as Messages<EnDictionary[NS]>;
  return createT(messages, en[ns], locale);
}
