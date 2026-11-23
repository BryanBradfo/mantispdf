import type { Dictionary, MessageValue } from "../i18n/types";
import type { EnDictionary } from "../i18n/locales/en";
import { interpolate } from "../i18n/translate";
import { TOOLS, toolById, toolsIn, type ToolId } from "../lib/tools";

/** A whole locale (English or a loaded translation), as the app and the prerender both hold it. */
export type AppDictionary = Dictionary<EnDictionary>;

export interface QA {
  q: string;
  a: string;
}

export interface ToolGuideContent {
  /** "How to merge PDF files": the guide's title and the HowTo name. */
  howTo: string;
  /** One or two sentences: what the tool does. */
  what: string;
  steps: string[];
  faq: QA[];
}

/** A plain string message of a namespace, or undefined (guide texts have no plural forms). */
export function message(dict: AppDictionary, ns: keyof AppDictionary, key: string): string | undefined {
  const messages: Readonly<Record<string, MessageValue>> = dict[ns];
  const value = messages[key];
  return typeof value === "string" ? value : undefined;
}

function required(dict: AppDictionary, ns: keyof AppDictionary, key: string): string {
  const value = message(dict, ns, key);
  if (value === undefined) throw new Error(`Missing message ${String(ns)}.${key}`);
  return value;
}

/** Numbered keys `prefix1`, `prefix2`... present in the namespace, in order. */
function numbered(dict: AppDictionary, prefix: string): number[] {
  const found: number[] = [];
  for (let i = 1; message(dict, "howto", `${prefix}${i}`) !== undefined; i++) found.push(i);
  return found;
}

/** The "How it works" content of a tool: title, what it does, steps and FAQ. */
export function toolGuide(dict: AppDictionary, id: ToolId): ToolGuideContent {
  return {
    howTo: required(dict, "howto", `${id}.howTo`),
    what: required(dict, "howto", `${id}.what`),
    steps: numbered(dict, `${id}.step`).map((i) => required(dict, "howto", `${id}.step${i}`)),
    faq: numbered(dict, `${id}.q`).map((i) => ({
      q: required(dict, "howto", `${id}.q${i}`),
      a: required(dict, "howto", `${id}.a${i}`),
    })),
  };
}

/** The home page FAQ (what, free, uploads, offline, which tools). */
export function homeFaq(dict: AppDictionary): QA[] {
  return numbered(dict, "home.q").map((i) => ({
    q: required(dict, "howto", `home.q${i}`),
    a: interpolate(required(dict, "howto", `home.a${i}`), { count: TOOLS.length }),
  }));
}

/** The other tools of the same section, in table order. */
export function relatedTools(id: ToolId): ToolId[] {
  return toolsIn(toolById(id).section)
    .map((t) => t.id)
    .filter((other) => other !== id);
}

/** Tool name ("Merge PDF") and one-line description, from the home grid. */
export function toolTitle(dict: AppDictionary, id: ToolId): string {
  return required(dict, "home", `${id}.title`);
}

export function toolDescription(dict: AppDictionary, id: ToolId): string {
  return required(dict, "home", `${id}.desc`);
}

/** The tool page's own strings (its namespace is named after its id): SEO title and description, heading, intro. */
export function toolPage(dict: AppDictionary, id: ToolId) {
  const extra = id === "removePages" || id === "extractPages" ? ` ${required(dict, "pages", "everythingLocal")}` : "";
  return {
    title: required(dict, id, "seoTitle"),
    description: required(dict, id, "seoDescription"),
    heading: required(dict, id, "heading"),
    intro: required(dict, id, "intro") + extra,
  };
}
