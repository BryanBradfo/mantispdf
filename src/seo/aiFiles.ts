import { LOCALES } from "../i18n/locale";
import { interpolate } from "../i18n/translate";
import { ASSET_KINDS, DESKTOP_VERSION, assetUrl } from "../lib/desktopRelease";
import { SECTIONS, TOOLS, toolsIn } from "../lib/tools";
import { SITE, seoUrls } from "../components/seo/seoUrls";
import { homeFaq, message, toolDescription, toolGuide, toolPage, toolTitle, type AppDictionary } from "./guide";
import { PAGE_PATHS } from "./staticPage";

const absolute = (path: string) => seoUrls(path, "en").canonical;

function summary(dict: AppDictionary): string {
  return interpolate(message(dict, "seo", "homeDescription") ?? "", { count: TOOLS.length });
}

function sectionName(dict: AppDictionary, section: string): string {
  return message(dict, "home", `sections.${section}`) ?? section;
}

/** /llms.txt (llmstxt.org): what MantisPDF is, every tool with its URL, the desktop app, privacy. English. */
export function llmsTxt(dict: AppDictionary): string {
  const faq = homeFaq(dict);
  const lines = [
    "# MantisPDF",
    "",
    `> ${summary(dict)}`,
    "",
    faq[0].a,
    "",
    "## Tools",
    "",
    ...TOOLS.map((t) => `- [${toolTitle(dict, t.id)}](${absolute(t.href)}): ${toolDescription(dict, t.id)}`),
    "",
    "## Desktop app",
    "",
    `- [Download MantisPDF ${DESKTOP_VERSION} for macOS, Windows and Linux](${absolute("/download")}): ${interpolate(message(dict, "download", "intro") ?? "", { count: TOOLS.length })}`,
    "",
    "## Privacy",
    "",
    `- ${faq[2].a}`,
    `- ${faq[3].a}`,
    `- ${faq[1].a}`,
    "",
    "## Optional",
    "",
    `- [Full guide](${SITE}/llms-full.txt): what every tool does, how to use it, and its FAQ`,
    `- [Home FAQ](${absolute("/")}#faq): questions and answers about MantisPDF`,
    `- [French version](${seoUrls("/", "fr").canonical}): the site in French`,
    "",
  ];
  return lines.join("\n");
}

/** /llms-full.txt: every tool's what, how and FAQ, in English. */
export function llmsFullTxt(dict: AppDictionary): string {
  const out = ["# MantisPDF", "", `> ${summary(dict)}`, "", "## FAQ", ""];
  for (const { q, a } of homeFaq(dict)) out.push(`### ${q}`, "", a, "");
  for (const section of SECTIONS) {
    out.push(`## ${sectionName(dict, section)}`, "");
    for (const tool of toolsIn(section)) {
      const guide = toolGuide(dict, tool.id);
      out.push(`### ${toolTitle(dict, tool.id)}`, "", `URL: ${absolute(tool.href)}`, "", guide.what, "", toolPage(dict, tool.id).intro, "");
      out.push(`#### ${guide.howTo}`, "", ...guide.steps.map((s, i) => `${i + 1}. ${s}`), "");
      out.push("#### FAQ", "");
      for (const { q, a } of guide.faq) out.push(`- ${q} ${a}`);
      out.push("");
    }
  }
  out.push("## Desktop app", "", `Version ${DESKTOP_VERSION}: ${absolute("/download")}`, "");
  for (const kind of ASSET_KINDS) out.push(`- ${message(dict, "download", kind) ?? kind}: ${assetUrl(kind)}`);
  out.push("");
  return out.join("\n");
}

/** sitemap.xml: every page in every locale, with its hreflang alternates and today's date. */
export function sitemapXml(date: string): string {
  const urls = LOCALES.flatMap((locale) =>
    PAGE_PATHS.map((path) => {
      const { canonical, alternates } = seoUrls(path, locale);
      const links = alternates
        .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hrefLang}" href="${a.href}"/>`)
        .join("\n");
      const priority = path === "/" ? "1.0" : path === "/download" ? "0.6" : "0.8";
      return `  <url>\n    <loc>${canonical}</loc>\n${links}\n    <lastmod>${date}</lastmod>\n    <priority>${priority}</priority>\n  </url>`;
    }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}
