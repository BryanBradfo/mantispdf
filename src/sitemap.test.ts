import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localizeRoutes } from "./i18n";
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
});
