import type { Dictionary } from "../../types";
import type { EnDictionary } from "../en";
import common from "./common";

/** French, loaded as its own chunk when a `/fr` page is first rendered. */
const fr: Dictionary<EnDictionary> = { common };

export default fr;
