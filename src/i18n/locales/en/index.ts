import common from "./common";
import home from "./home";
import seo from "./seo";

/** The English dictionary, bundled with the app. Add a namespace here, then in every locale. */
export const en = { common, home, seo };

export type EnDictionary = typeof en;
export type NamespaceName = keyof EnDictionary;
