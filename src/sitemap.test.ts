import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localePath, localizeRoutes, stripLocale } from "./i18n";
import { APP_ROUTES, isRedirect } from "./routes";

const SITE = "https://mantispdf.vercel.app";
const xml = readFileSync(resolve(__dirname, "../public/sitemap.xml"), "utf8");
const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

// Pages worth indexing: every route but the 404 catch-all and the legacy redirects.
const pages = localizeRoutes(APP_ROUTES.filter((r) => r.path !== "*" && !isRedirect(r))).map((r) =>
  r.path === "/" ? `${SITE}/` : `${SITE}${r.path}`,
);

describe("public/sitemap.xml", () => {
  it("lists every page in English and in French, once", () => {
    expect([...locs].sort()).toEqual([...pages].sort());
  });

  it("gives every page its hreflang alternates", () => {
    const alternates = xml.match(/<xhtml:link rel="alternate" hreflang="(en|fr|x-default)"/g) ?? [];
    expect(alternates.length).toBe(locs.length * 3);
  });

  it("points each url's alternates at that same page", () => {
    const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
    expect(urls.length).toBe(locs.length);
    for (const block of urls) {
      const loc = /<loc>([^<]+)<\/loc>/.exec(block)![1];
      const path = loc.slice(SITE.length);
      const englishPath = stripLocale(path === "" ? "/" : path);
      const href = (lang: string) => new RegExp(`hreflang="${lang}" href="([^"]+)"`).exec(block)?.[1];
      const english = englishPath === "/" ? `${SITE}/` : `${SITE}${englishPath}`;
      expect(href("en"), loc).toBe(english);
      expect(href("x-default"), loc).toBe(english);
      expect(href("fr"), loc).toBe(`${SITE}${localePath(englishPath, "fr")}`);
    }
  });
});
