import { en } from "../i18n/locales/en";
import fr from "../i18n/locales/fr/fr";
import type { Locale } from "../i18n/locale";
import { llmsFullTxt, llmsTxt, sitemapXml } from "./aiFiles";
import type { AppDictionary } from "./guide";
import { prerenderedPages, renderPage } from "./staticPage";

const DICTIONARIES: Record<Locale, AppDictionary> = { en, fr };

/** The bare app shell, served for every path that has no page of its own (legacy redirects, 404). */
export const SHELL_FILE = "shell.html";

export interface BuiltFile {
  /** Path under dist/. */
  file: string;
  content: string;
}

/**
 * Everything the build adds to dist/ from the built `index.html` (the shell): one prerendered page per
 * page and locale (the English home replaces index.html), the shell kept as shell.html, llms.txt,
 * llms-full.txt and sitemap.xml. `date` is the sitemap's lastmod (YYYY-MM-DD).
 */
export function buildSeoFiles(shell: string, date: string): BuiltFile[] {
  return [
    { file: SHELL_FILE, content: shell },
    ...prerenderedPages().map((p) => ({ file: p.file, content: renderPage(shell, DICTIONARIES[p.locale], p.locale, p.path) })),
    { file: "llms.txt", content: llmsTxt(en) },
    { file: "llms-full.txt", content: llmsFullTxt(en) },
    { file: "sitemap.xml", content: sitemapXml(date) },
  ];
}
