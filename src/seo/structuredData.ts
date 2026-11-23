import type { Locale } from "../i18n/locale";
import { interpolate } from "../i18n/translate";
import { ASSET_KINDS, DESKTOP_VERSION, RELEASES_URL, assetUrl } from "../lib/desktopRelease";
import { TOOLS, toolById, type ToolId } from "../lib/tools";
import { SITE, seoUrls } from "../components/seo/seoUrls";
import { homeFaq, message, toolGuide, toolPage, toolTitle, type AppDictionary, type QA } from "./guide";

/** A schema.org JSON-LD document: one `@graph` of nodes. */
export interface JsonLd {
  "@context": "https://schema.org";
  "@graph": Record<string, unknown>[];
}

const ORG_ID = `${SITE}/#organization`;
const SITE_ID = `${SITE}/#website`;
const FREE = { "@type": "Offer", price: "0", priceCurrency: "USD" };

const url = (path: string, locale: Locale) => seoUrls(path, locale).canonical;

function graph(nodes: Record<string, unknown>[]): JsonLd {
  return { "@context": "https://schema.org", "@graph": nodes };
}

function faqPage(id: string, faq: QA[], locale: Locale) {
  return {
    "@type": "FAQPage",
    "@id": id,
    inLanguage: locale,
    mainEntity: faq.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
}

function organization() {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: "MantisPDF",
    url: `${SITE}/`,
    logo: `${SITE}/apple-touch-icon.png`,
  };
}

function homeDescription(dict: AppDictionary): string {
  return interpolate(message(dict, "seo", "homeDescription") ?? "", { count: TOOLS.length });
}

/** Home: WebSite, Organization, SoftwareApplication (every tool as a feature) and the home FAQ. */
export function homeJsonLd(dict: AppDictionary, locale: Locale): JsonLd {
  const home = url("/", locale);
  return graph([
    {
      "@type": "WebSite",
      "@id": SITE_ID,
      name: "MantisPDF",
      url: `${SITE}/`,
      inLanguage: locale,
      publisher: { "@id": ORG_ID },
    },
    organization(),
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE}/#app`,
      name: "MantisPDF",
      url: home,
      description: homeDescription(dict),
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web, Windows, macOS, Linux",
      offers: FREE,
      isAccessibleForFree: true,
      featureList: TOOLS.map((t) => toolTitle(dict, t.id)),
      downloadUrl: url("/download", locale),
      softwareVersion: DESKTOP_VERSION,
      publisher: { "@id": ORG_ID },
    },
    faqPage(`${home}#faq`, homeFaq(dict), locale),
  ]);
}

/** A tool page: WebApplication, HowTo (the guide steps), FAQPage and BreadcrumbList (Home > section > tool). */
export function toolJsonLd(dict: AppDictionary, locale: Locale, id: ToolId): JsonLd {
  const tool = toolById(id);
  const page = url(tool.href, locale);
  const home = url("/", locale);
  const guide = toolGuide(dict, id);
  const { description } = toolPage(dict, id);
  const name = toolTitle(dict, id);
  return graph([
    {
      "@type": "WebApplication",
      "@id": `${page}#app`,
      name,
      url: page,
      description,
      inLanguage: locale,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web, Windows, macOS, Linux",
      browserRequirements: "Requires JavaScript and WebAssembly",
      isAccessibleForFree: true,
      offers: FREE,
      publisher: { "@id": ORG_ID },
    },
    {
      "@type": "HowTo",
      "@id": `${page}#howto`,
      name: guide.howTo,
      description: guide.what,
      inLanguage: locale,
      step: guide.steps.map((text, i) => ({
        "@type": "HowToStep",
        position: i + 1,
        name: text,
        text,
        url: `${page}#step-${i + 1}`,
      })),
    },
    faqPage(`${page}#faq`, guide.faq, locale),
    {
      "@type": "BreadcrumbList",
      "@id": `${page}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: message(dict, "howto", "home") ?? "MantisPDF", item: home },
        {
          "@type": "ListItem",
          position: 2,
          name: message(dict, "home", `sections.${tool.section}`) ?? tool.section,
          item: `${home}#section-${tool.section}`,
        },
        { "@type": "ListItem", position: 3, name, item: page },
      ],
    },
  ]);
}

/** /download: the desktop app, with every installer. */
export function downloadJsonLd(dict: AppDictionary, locale: Locale): JsonLd {
  const description = interpolate(message(dict, "download", "seoDescription") ?? "", { count: TOOLS.length });
  return graph([
    organization(),
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE}/download#app`,
      name: "MantisPDF",
      url: url("/download", locale),
      description,
      inLanguage: locale,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Windows, macOS, Linux",
      softwareVersion: DESKTOP_VERSION,
      offers: FREE,
      isAccessibleForFree: true,
      downloadUrl: ASSET_KINDS.map((kind) => assetUrl(kind)),
      releaseNotes: RELEASES_URL,
      featureList: TOOLS.map((t) => toolTitle(dict, t.id)),
      publisher: { "@id": ORG_ID },
    },
  ]);
}

/** The JSON-LD of any indexable page, by its English path (`/`, `/merge`, `/download`). */
export function pageJsonLd(dict: AppDictionary, locale: Locale, path: string): JsonLd {
  if (path === "/") return homeJsonLd(dict, locale);
  if (path === "/download") return downloadJsonLd(dict, locale);
  const tool = TOOLS.find((t) => t.href === path);
  if (!tool) throw new Error(`No structured data for ${path}`);
  return toolJsonLd(dict, locale, tool.id);
}

/** JSON for an inline `<script>`: `<` escaped so the text can never close the element. */
export function jsonLdScript(doc: JsonLd): string {
  return JSON.stringify(doc).replace(/</g, "\\u003c");
}
