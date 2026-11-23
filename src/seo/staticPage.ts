import { LOCALES, localePath, type Locale } from "../i18n/locale";
import { interpolate } from "../i18n/translate";
import { ASSET_KINDS, DESKTOP_VERSION, assetUrl } from "../lib/desktopRelease";
import { SECTIONS, TOOLS, sectionNumber, toolById, toolsIn, type ToolId } from "../lib/tools";
import { SITE, seoUrls } from "../components/seo/seoUrls";
import {
  homeFaq,
  message,
  relatedTools,
  toolDescription,
  toolGuide,
  toolPage,
  toolTitle,
  type AppDictionary,
  type QA,
} from "./guide";
import { guide as g } from "./guideStyles";
import { jsonLdScript, pageJsonLd } from "./structuredData";

/** Every indexable page, by English path: home, the tools, the desktop download. Redirects and 404 are not pages. */
export const PAGE_PATHS: readonly string[] = ["/", ...TOOLS.map((t) => t.href), "/download"];

export interface PrerenderedPage {
  /** English path (`/merge`). */
  path: string;
  locale: Locale;
  /** URL path in its locale (`/fr/merge`). */
  url: string;
  /** File under dist/: `index.html`, `fr/index.html`, `fr/merge/index.html`. */
  file: string;
}

/** The pages written at build time: every page in every locale. */
export function prerenderedPages(): PrerenderedPage[] {
  return LOCALES.flatMap((locale) =>
    PAGE_PATHS.map((path) => {
      const url = localePath(path, locale);
      return { path, locale, url, file: url === "/" ? "index.html" : `${url.slice(1)}/index.html` };
    }),
  );
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Title and description of a page, the same values PageSEO renders. */
export function pageMeta(dict: AppDictionary, path: string): { title: string; description: string } {
  const count = { count: TOOLS.length };
  if (path === "/") {
    return {
      title: message(dict, "seo", "homeTitle") ?? "MantisPDF",
      description: interpolate(message(dict, "seo", "homeDescription") ?? "", count),
    };
  }
  if (path === "/download") {
    return {
      title: message(dict, "download", "seoTitle") ?? "MantisPDF",
      description: interpolate(message(dict, "download", "seoDescription") ?? "", count),
    };
  }
  const { title, description } = toolPage(dict, toolAt(path));
  return { title, description };
}

function toolAt(path: string): ToolId {
  const tool = TOOLS.find((t) => t.href === path);
  if (!tool) throw new Error(`Not a tool page: ${path}`);
  return tool.id;
}

/**
 * The head tags of a page: title, description, canonical, hreflang, og:, twitter: (as PageSEO) and the
 * JSON-LD. Each carries `data-prerender`: main.tsx removes them before the app mounts, so the tags
 * PageSEO then renders are the only ones.
 */
export function headTags(dict: AppDictionary, locale: Locale, path: string): string {
  const { title, description } = pageMeta(dict, path);
  const { canonical, alternates, ogLocale } = seoUrls(path, locale);
  const image = `${SITE}/og-${locale}.png`;
  const attr = escapeHtml;
  const tags = [
    `<title data-prerender>${escapeHtml(title)}</title>`,
    `<meta data-prerender name="description" content="${attr(description)}" />`,
    `<link data-prerender rel="canonical" href="${attr(canonical)}" />`,
    ...alternates.map((a) => `<link data-prerender rel="alternate" hreflang="${a.hrefLang}" href="${attr(a.href)}" />`),
    `<meta data-prerender property="og:type" content="website" />`,
    `<meta data-prerender property="og:locale" content="${ogLocale}" />`,
    `<meta data-prerender property="og:title" content="${attr(title)}" />`,
    `<meta data-prerender property="og:description" content="${attr(description)}" />`,
    `<meta data-prerender property="og:url" content="${attr(canonical)}" />`,
    `<meta data-prerender property="og:image" content="${attr(image)}" />`,
    `<meta data-prerender name="twitter:card" content="summary_large_image" />`,
    `<meta data-prerender name="twitter:title" content="${attr(title)}" />`,
    `<meta data-prerender name="twitter:description" content="${attr(description)}" />`,
    `<meta data-prerender name="twitter:image" content="${attr(image)}" />`,
    `<script data-prerender type="application/ld+json">${jsonLdScript(pageJsonLd(dict, locale, path))}</script>`,
  ];
  return tags.map((t) => `    ${t}`).join("\n");
}

function link(href: string, locale: Locale, text: string, className = ""): string {
  const cls = className ? ` class="${className}"` : "";
  return `<a href="${escapeHtml(localePath(href, locale))}"${cls}>${escapeHtml(text)}</a>`;
}

function faqHtml(faq: QA[]): string {
  const items = faq
    .map(
      ({ q, a }) =>
        `<details class="${g.faqItem}"><summary class="${g.faqSummary}"><h3 class="${g.faqQuestion}">${escapeHtml(q)}</h3></summary><p class="${g.faqAnswer}">${escapeHtml(a)}</p></details>`,
    )
    .join("");
  return `<div class="${g.faqList}">${items}</div>`;
}

function guideHtml(dict: AppDictionary, locale: Locale, id: ToolId): string {
  const content = toolGuide(dict, id);
  const steps = content.steps
    .map(
      (s, i) =>
        `<li id="step-${i + 1}" class="${g.step}"><span class="${g.stepNumber}">${String(i + 1).padStart(2, "0")}</span><span class="${g.stepText}">${escapeHtml(s)}</span></li>`,
    )
    .join("");
  const related = relatedTools(id)
    .map((other) => `<li class="${g.relatedItem}">${link(toolById(other).href, locale, toolTitle(dict, other), g.relatedLink)}</li>`)
    .join("");
  const text = (key: string) => escapeHtml(message(dict, "howto", key) ?? "");
  return [
    `<section class="${g.section}" aria-labelledby="guide-title">`,
    `<p class="${g.eyebrow}">${text("eyebrow")}</p>`,
    `<h2 id="guide-title" class="${g.title}">${escapeHtml(content.howTo)}</h2>`,
    `<p class="${g.lead}">${escapeHtml(content.what)}</p>`,
    `<ol class="${g.steps}">${steps}</ol>`,
    `<h2 id="faq" class="${g.subTitle}">${text("faq")}</h2>`,
    faqHtml(content.faq),
    related ? `<h2 class="${g.subTitle}">${text("related")}</h2><ul class="${g.related}">${related}</ul>` : "",
    `</section>`,
  ].join("");
}

/** Every tool, by section, with localized links: the static page's site map. */
function allToolsNav(dict: AppDictionary, locale: Locale, withDescriptions: boolean): string {
  const sections = SECTIONS.map((section) => {
    const items = toolsIn(section)
      .map((t) => {
        const desc = withDescriptions ? ` <span class="text-ink-2">${escapeHtml(toolDescription(dict, t.id))}</span>` : "";
        return `<li class="py-1">${link(t.href, locale, toolTitle(dict, t.id), "text-ink underline-offset-4 hover:underline")}${desc}</li>`;
      })
      .join("");
    const name = escapeHtml(message(dict, "home", `sections.${section}`) ?? section);
    return `<section id="section-${section}" class="mt-8"><h3 class="font-mono text-xs uppercase tracking-[0.08em] text-ink">${sectionNumber(section)} / ${name}</h3><ul class="mt-3 text-sm leading-relaxed">${items}</ul></section>`;
  }).join("");
  const title = escapeHtml(message(dict, "howto", "allTools") ?? "");
  return `<nav class="mt-20 border-t border-line pt-10" aria-labelledby="all-tools"><h2 id="all-tools" class="eyebrow">${title}</h2>${sections}</nav>`;
}

const SHELL = "mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-8 sm:pt-12";
const H1 = "mt-5 font-display text-[2.75rem] font-light leading-[0.95] tracking-[-0.02em] text-ink sm:text-6xl";
const INTRO = "mt-4 max-w-xl leading-relaxed text-ink-2";

function brand(locale: Locale): string {
  return `<p class="font-display text-lg uppercase tracking-[0.2em] text-ink">${link("/", locale, "MantisPDF")}</p>`;
}

function homeBody(dict: AppDictionary, locale: Locale): string {
  const text = (ns: "home" | "howto", key: string) => escapeHtml(message(dict, ns, key) ?? "");
  return [
    `<main data-prerender-body class="${SHELL}">`,
    brand(locale),
    `<p class="eyebrow mt-10">${escapeHtml(interpolate(message(dict, "home", "heroEyebrowTools") ?? "", { count: TOOLS.length }))}</p>`,
    `<h1 class="${H1}">${text("home", "heading")}</h1>`,
    `<p class="mt-6 font-display text-2xl font-light text-ink">${text("home", "tagline")}</p>`,
    `<p class="${INTRO}">${text("home", "intro")}</p>`,
    `<p class="mt-6">${link("/download", locale, message(dict, "home", "downloadApp") ?? "", "text-ink underline underline-offset-4")}</p>`,
    allToolsNav(dict, locale, true),
    `<section class="${g.section}" aria-labelledby="faq"><p class="${g.eyebrow}">${text("howto", "faq")}</p><h2 id="faq" class="${g.title}">${text("howto", "homeFaqTitle")}</h2>${faqHtml(homeFaq(dict))}</section>`,
    `</main>`,
  ].join("");
}

function toolBody(dict: AppDictionary, locale: Locale, id: ToolId): string {
  const { heading, intro } = toolPage(dict, id);
  const section = toolById(id).section;
  const sectionName = escapeHtml(message(dict, "home", `sections.${section}`) ?? section);
  return [
    `<main data-prerender-body class="${SHELL}">`,
    brand(locale),
    `<p class="eyebrow mt-10">${sectionNumber(section)} / ${sectionName}</p>`,
    `<h1 class="${H1}">${escapeHtml(heading)}</h1>`,
    `<p class="${INTRO}">${escapeHtml(intro)}</p>`,
    guideHtml(dict, locale, id),
    allToolsNav(dict, locale, false),
    `</main>`,
  ].join("");
}

function downloadBody(dict: AppDictionary, locale: Locale): string {
  const text = (key: string, params?: Record<string, string | number>) =>
    escapeHtml(interpolate(message(dict, "download", key) ?? "", params));
  const installers = ASSET_KINDS.map(
    (kind) => `<li class="py-1"><a class="text-ink underline underline-offset-4" href="${escapeHtml(assetUrl(kind))}">${text(kind)}</a></li>`,
  ).join("");
  return [
    `<main data-prerender-body class="${SHELL}">`,
    brand(locale),
    `<p class="eyebrow mt-10">${text("eyebrow")}</p>`,
    `<h1 class="${H1}">${text("heading")}</h1>`,
    `<p class="${INTRO}">${text("intro", { count: TOOLS.length })}</p>`,
    `<ul class="mt-8 text-sm">${installers}</ul>`,
    `<p class="mt-6 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">${text("version", { version: DESKTOP_VERSION })}</p>`,
    allToolsNav(dict, locale, false),
    `</main>`,
  ].join("");
}

/**
 * The static content of a page, put inside `<div id="root">` (the app replaces it when it mounts). Its
 * `<main data-prerender-body>` is hidden in the desktop app (index.html's inline script and style).
 */
export function bodyHtml(dict: AppDictionary, locale: Locale, path: string): string {
  if (path === "/") return homeBody(dict, locale);
  if (path === "/download") return downloadBody(dict, locale);
  return toolBody(dict, locale, toolAt(path));
}

/** The built index.html with a page's head tags, `<html lang>` and static content. */
export function renderPage(shell: string, dict: AppDictionary, locale: Locale, path: string): string {
  if (!shell.includes('<div id="root"></div>') || !shell.includes("</head>")) {
    throw new Error("index.html has no empty #root or no </head>");
  }
  return shell
    .replace(/<html lang="[^"]*"/, `<html lang="${locale}"`)
    .replace(/\s*<\/head>/, () => `\n${headTags(dict, locale, path)}\n  </head>`)
    .replace('<div id="root"></div>', () => `<div id="root">${bodyHtml(dict, locale, path)}</div>`);
}
