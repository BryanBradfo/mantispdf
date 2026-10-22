import common from "./common";

/** The English dictionary, bundled with the app. Add a namespace here, then in every locale. */
export const en = { common };

export type EnDictionary = typeof en;
export type NamespaceName = keyof EnDictionary;
