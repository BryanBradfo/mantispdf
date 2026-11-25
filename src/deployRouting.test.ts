import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localizeRoutes } from "./i18n";
import { APP_ROUTES } from "./routes";
import { prerenderedPages } from "./seo/staticPage";
import { SHELL_FILE } from "./seo/build";

/**
 * MantisPDF uses <BrowserRouter>, so every client route must be served an HTML page by the host.
 * Vercel serves static files only: without a rewrite, a hard load / refresh / shared link of `/split`
 * returns Vercel's own 404 before any JS runs.
 *
 * Every indexable page is prerendered at build (src/seo/staticPage.ts, scripts/prerender.mjs) to
 * `dist/<path>/index.html`; vercel.json rewrites each page URL to its file (so the routing does not
 * depend on how the host maps a directory), and every other path (legacy redirects, unknown paths)
 * to the bare SPA shell, `dist/shell.html`, where React Router redirects or renders NotFound.
 *
 * This cannot be caught by Playwright: `vite preview` has its own fallback, so the built app looks
 * fine locally while production 404s. The deployment contract is asserted against vercel.json.
 */

const root = resolve(__dirname, "..");

// Every rendered path: the route table under the root and under each locale prefix (/fr/...).
const clientRoutes = (): string[] =>
  localizeRoutes(APP_ROUTES)
    .map((r) => r.path)
    .filter((p) => !p.includes("*"));

type Rewrite = { source: string; destination: string };

const rewrites = (): Rewrite[] => {
  const cfg = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));
  return cfg.rewrites ?? [];
};

/**
 * Vercel's path-to-regexp sources, as far as vercel.json uses them: a named group `:name(a|b)`
 * (its value fills `:name` in the destination) and an unnamed group `(.*)`.
 */
function resolveRewrite(rule: Rewrite, path: string): string | undefined {
  const names: string[] = [];
  const pattern = rule.source.replace(/:(\w+)\(([^)]*)\)/g, (_m, name: string, alt: string) => {
    names.push(name);
    return `(${alt})`;
  });
  const m = new RegExp(`^${pattern}$`).exec(path);
  if (!m) return undefined;
  return names.reduce((dest, name, i) => dest.replace(`:${name}`, m[i + 1]), rule.destination);
}

const destinationFor = (path: string): string | undefined => {
  for (const rule of rewrites()) {
    const dest = resolveRewrite(rule, path);
    if (dest !== undefined) return dest;
  }
  return undefined;
};

/** What Vercel serves for a hard load of `path`: the home is dist/index.html, the rest goes through the rewrites. */
const servedFile = (path: string): string | undefined => (path === "/" ? "/index.html" : destinationFor(path));

describe("vercel.json routing", () => {
  it("declares at least one route to protect", () => {
    expect(clientRoutes().length).toBeGreaterThan(1);
  });

  it("includes the French mirror of every route", () => {
    expect(clientRoutes()).toEqual(expect.arrayContaining(["/fr", "/fr/merge", "/fr/ocr"]));
  });

  it.each(prerenderedPages().map((p) => [p.url, p.file]))("serves %s its prerendered file %s", (url, file) => {
    expect(servedFile(url)).toBe(`/${file}`);
  });

  it.each(clientRoutes())("serves an HTML page for a hard load of %s", (path) => {
    expect(servedFile(path)).toMatch(/\.html$/);
  });

  it.each(["/edit", "/jpg-to-pdf", "/fr/edit", "/no-such-page", "/fr/no-such-page", "/merge/extra"])(
    "serves the bare SPA shell for %s (a redirect or NotFound, not another page's content)",
    (path) => {
      expect(destinationFor(path)).toBe(`/${SHELL_FILE}`);
    },
  );

  // Static assets need no exclusion here: Vercel gives "precedence to the
  // filesystem prior to rewrites being applied", so /assets/*, /llms.txt, /sitemap.xml
  // and friends are served as files and never reach the catch-all.
  // Vercel serves files before rewrites, but a specific rewrite must never claim them.
  it.each(["/sw.js", "/workbox-07f22231.js", "/sw-runtime-ac767fb040-c6ef4774b0.js", "/manifest.webmanifest", "/icons/pwa-512.png"])(
    "has no page rewrite for the web app file %s",
    (path) => {
      const specific = rewrites().filter((r) => r.source !== "/(.*)");
      expect(specific.map((r) => resolveRewrite(r, path)).filter(Boolean)).toEqual([]);
    },
  );

  it("keeps the catch-all last so a future specific rewrite is not shadowed", () => {
    const all = rewrites();
    const catchAllIndex = all.findIndex((r) => r.source === "/(.*)");

    expect(catchAllIndex).toBe(all.length - 1);
  });

  it("drops trailing slashes, so /merge/ and /merge are one URL", () => {
    const cfg = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));
    expect(cfg.trailingSlash).toBe(false);
  });
});

type Header = { source: string; headers: { key: string; value: string }[] };

const cacheControlFor = (path: string): string | undefined => {
  const cfg = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));
  const rules: Header[] = cfg.headers ?? [];
  return rules
    .filter((r) => new RegExp(`^${r.source}$`).test(path))
    .flatMap((r) => r.headers)
    .find((h) => h.key.toLowerCase() === "cache-control")?.value;
};

describe("vercel.json cache headers", () => {
  // Fonts (up to 10 MB for CJK) and the OCR runtime are fetched on demand and never change for a
  // file name: the browser keeps them a week and revalidates in the background after that.
  it.each(["/fonts-runtime/NotoSansSC_400Regular.ttf", "/fonts-runtime/fonts.json", "/ocr-runtime/tesseract-core.wasm"])(
    "caches %s for a week",
    (path) => {
      expect(cacheControlFor(path)).toBe("public, max-age=604800, stale-while-revalidate=86400");
    },
  );

  // The browser checks /sw.js for a new version on navigations; a cached copy would delay every deploy.
  it("never lets a cache keep the service worker", () => {
    expect(cacheControlFor("/sw.js")).toBe("no-cache");
  });

  it("keeps the web app manifest an hour at most", () => {
    expect(cacheControlFor("/manifest.webmanifest")).toBe("public, max-age=3600");
  });

  it("leaves the app shell to the host's default (it must update on deploy)", () => {
    expect(cacheControlFor("/index.html")).toBeUndefined();
    expect(cacheControlFor("/edit-pdf")).toBeUndefined();
  });
});
