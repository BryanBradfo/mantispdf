import { describe, it, expect } from "vitest";
import { en } from "./locales/en";
import fr from "./locales/fr/fr";
import type { MessageValue } from "./types";

/** Every message text of a dictionary, as [id, text] (one entry per plural form). */
function texts(dict: Record<string, Record<string, MessageValue>>): [string, string][] {
  return Object.entries(dict).flatMap(([ns, messages]) =>
    Object.entries(messages).flatMap(([key, value]) =>
      typeof value === "string"
        ? [[`${ns}.${key}`, value] as [string, string]]
        : Object.entries(value).map(([form, text]) => [`${ns}.${key}.${form}`, text ?? ""] as [string, string]),
    ),
  );
}

const UNITS = "pages?|images?|fichiers?|feuilles?|mots?|Mo|Ko|mm|pt|px|pouces|octets|mégapixels|dpi";

/** French rules; each returns the offending excerpt or null. */
const RULES: [string, RegExp][] = [
  ["no em-dash", /—/],
  ["NBSP (not a space) before : ; ! ?", /\S [:;!?](?=\s|$|")/],
  ["no space at all before : ; ! ?", /[\p{L}\d)}»](?<!https?)[:;!?](?=\s|$)/u],
  ["NBSP after «", /«(?!\u00a0)/],
  ["NBSP before »", /(?<!\u00a0)»/],
  ["NBSP between a number and its unit", new RegExp(`(\\d|\\}) (${UNITS})(?![\\p{L}])`, "u")],
  ["NBSP before %", /(\d|\}) ?%/],
  ["typographic apostrophe (’), not '", /'/],
  ["ellipsis character (…), not ...", /\.\.\./],
  ["«\u00a0interrogeable\u00a0», not «\u00a0cherchable\u00a0»", /cherchable/i],
];

describe("French typography", () => {
  const all = texts(fr);
  it.each(RULES)("%s", (_rule, pattern) => {
    const bad = all.filter(([, text]) => pattern.test(text.replace(/\u00a0%/g, "\u00a0PCT")));
    expect(bad.map(([id, text]) => `${id}: ${text}`)).toEqual([]);
  });
});

describe("English typography", () => {
  it("has no em-dash", () => {
    expect(texts(en).filter(([, text]) => text.includes("—")).map(([id]) => id)).toEqual([]);
  });
});
