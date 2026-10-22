import type { Dictionary } from "../../types";
import type { EnDictionary } from "../en";
import common from "./common";
import home from "./home";
import seo from "./seo";

/** French, loaded as its own chunk when a `/fr` page is first rendered (or preloaded). */
const fr: Dictionary<EnDictionary> = { common, home, seo };

export default fr;
