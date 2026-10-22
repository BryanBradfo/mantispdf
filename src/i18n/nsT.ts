import type { EnDictionary, NamespaceName } from "./locales/en";
import type { TFunction } from "./types";

/** `t` for one namespace, as a parameter type: `function summary(n: number, t: NsT<"merge">)`. */
export type NsT<NS extends NamespaceName> = TFunction<EnDictionary[NS]>;
