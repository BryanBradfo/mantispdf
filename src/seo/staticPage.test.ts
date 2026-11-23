import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../i18n/locales/en";
import fr from "../i18n/locales/fr/fr";
import { localizeRoutes } from "../i18n/locale";
import { APP_ROUTES, isRedirect } from "../routes";
import { TOOLS } from "../lib/tools";
import { PAGE_PATHS, prerenderedPages, renderPage } from "./staticPage";
import { buildSeoFiles } from "./build";

const SHELL = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/index.js"></script>
  </body>
</html>`;

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("prerendered pages", () => {
  it("cover every route worth indexing, in every locale (no redirect, no 404)", () => {
    const routes = localizeRoutes(APP_ROUTES.filter((r) => r.path !== "*" && !isRedirect(r))).map((r) => r.path);
    expect(prerenderedPages().map((p) => p.url).sort()).toEqual([...routes].sort());
    expect(PAGE_PATHS).toHaveLength(TOOLS.length + 2);
  });

  it("write each page to <path>/index.html (the English home to index.html)", () => {
    const files = Object.fromEntries(prerenderedPages().map((p) => [p.url, p.file]));
    expect(files["/"]).toBe("index.html");
    expect(files["/fr"]).toBe("fr/index.html");
    expect(files["/fr/merge"]).toBe("fr/merge/index.html");
    expect(files["/download"]).toBe("download/index.html");
  });
});

describe("renderPage for /fr/merge", () => {
  const html = renderPage(SHELL, fr, "fr", "/merge");
  const d = doc(html);

  it("sets the French lang, title and description", () => {
    expect(d.documentElement.lang).toBe("fr");
    expect(d.title).toBe(fr.merge.seoTitle);
    expect(d.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(fr.merge.seoDescription);
  });

  it("has the canonical and hreflang alternates", () => {
    expect(d.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://mantispdf.bradfo.me/fr/merge");
    const alt = (lang: string) => d.querySelector(`link[rel="alternate"][hreflang="${lang}"]`)?.getAttribute("href");
    expect(alt("en")).toBe("https://mantispdf.bradfo.me/merge");
    expect(alt("fr")).toBe("https://mantispdf.bradfo.me/fr/merge");
    expect(alt("x-default")).toBe("https://mantispdf.bradfo.me/merge");
    expect(d.querySelector('meta[property="og:locale"]')?.getAttribute("content")).toBe("fr_FR");
  });

  it("marks every head tag it adds so the app can remove them", () => {
    const added = d.head.querySelectorAll("title, meta[name], meta[property], link, script");
    expect(added.length).toBeGreaterThan(10);
    for (const el of added) expect(el.hasAttribute("data-prerender"), el.outerHTML).toBe(true);
  });

  it("carries JSON-LD with HowTo and FAQPage", () => {
    const json = JSON.parse(d.querySelector('script[type="application/ld+json"]')!.textContent!);
    const types = json["@graph"].map((n: { "@type": string }) => n["@type"]);
    expect(types).toEqual(expect.arrayContaining(["WebApplication", "HowTo", "FAQPage", "BreadcrumbList"]));
  });

  it("puts the page content in #root: h1, intro, steps, FAQ, related tools, French links", () => {
    const root = d.getElementById("root")!;
    expect(root.querySelector("h1")?.textContent).toBe(fr.merge.heading);
    expect(root.textContent).toContain(fr.merge.intro);
    expect(root.querySelectorAll("ol li")).toHaveLength(3);
    expect(root.querySelectorAll("details summary")).toHaveLength(3);
    expect(root.textContent).toContain("Comment ça marche");
    const hrefs = [...root.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/fr/split");
    expect(hrefs).toContain("/fr/ocr");
    expect(hrefs.filter((h) => h && !h.startsWith("/fr"))).toEqual([]);
  });

  it("keeps the app's script", () => {
    expect(html).toContain('<script type="module" src="/assets/index.js"></script>');
  });
});

describe("renderPage for the home and /download", () => {
  it("home: the h1, every tool and the FAQ", () => {
    const d = doc(renderPage(SHELL, en, "en", "/"));
    expect(d.querySelector("#root h1")?.textContent).toBe(en.home.heading);
    expect(d.querySelectorAll("#root nav li")).toHaveLength(TOOLS.length);
    expect(d.querySelectorAll("#root details")).toHaveLength(5);
  });

  it("download: the installers", () => {
    const d = doc(renderPage(SHELL, en, "en", "/download"));
    expect(d.querySelector("#root h1")?.textContent).toBe(en.download.heading);
    expect([...d.querySelectorAll("#root a")].filter((a) => a.getAttribute("href")!.includes("/releases/download/"))).toHaveLength(7);
  });

  it("escapes text", () => {
    const html = renderPage(SHELL, en, "en", "/header-footer");
    expect(html).toContain("Header &amp; Footer");
  });

  it("refuses a shell without an empty #root", () => {
    expect(() => renderPage("<html><head></head><body></body></html>", en, "en", "/")).toThrow();
  });
});

describe("buildSeoFiles", () => {
  it("writes the shell, every page, llms.txt, llms-full.txt and sitemap.xml", () => {
    const files = buildSeoFiles(SHELL, "2026-11-23").map((f) => f.file);
    expect(files).toContain("shell.html");
    expect(files).toContain("index.html");
    expect(files).toContain("fr/merge/index.html");
    expect(files).toEqual(expect.arrayContaining(["llms.txt", "llms-full.txt", "sitemap.xml"]));
    expect(files.length).toBe(prerenderedPages().length + 4);
  });

  it("works on the real index.html", () => {
    const shell = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
    expect(() => buildSeoFiles(shell, "2026-11-23")).not.toThrow();
  });
});
