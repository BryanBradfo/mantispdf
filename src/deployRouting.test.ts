import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * MantisPDF uses <BrowserRouter>, so every client route must be served the
 * SPA shell by the host. Vercel serves static files only: without a rewrite,
 * a hard load / refresh / shared link of `/split` returns Vercel's own 404
 * before any JS runs.
 *
 * This cannot be caught by Playwright: `vite preview` has a built-in SPA
 * fallback, so the built app looks fine locally while production 404s. The
 * deployment contract therefore has to be asserted against vercel.json.
 */

const root = resolve(__dirname, "..");

const clientRoutes = (): string[] => {
  const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
  return [...app.matchAll(/path="(\/[^"*]*)"/g)].map((m) => m[1]);
};

type Rewrite = { source: string; destination: string };

const rewrites = (): Rewrite[] => {
  const cfg = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));
  return cfg.rewrites ?? [];
};

const destinationFor = (path: string): string | undefined =>
  rewrites().find((r) => new RegExp(`^${r.source}$`).test(path))?.destination;

describe("vercel.json SPA rewrites", () => {
  it("declares at least one route to protect", () => {
    expect(clientRoutes().length).toBeGreaterThan(1);
  });

  it.each(clientRoutes())("serves the SPA shell for a hard load of %s", (path) => {
    expect(destinationFor(path)).toBe("/index.html");
  });

  it("serves the SPA shell for an unknown path so React Router renders NotFound", () => {
    expect(destinationFor("/no-such-page")).toBe("/index.html");
  });

  // Static assets need no exclusion here: Vercel gives "precedence to the
  // filesystem prior to rewrites being applied", so /assets/*, /pdf.worker.min.mjs
  // and friends are served as files and never reach the catch-all.
  it("keeps the catch-all last so a future specific rewrite is not shadowed", () => {
    const all = rewrites();
    const catchAllIndex = all.findIndex((r) => r.source === "/(.*)");

    expect(catchAllIndex).toBe(all.length - 1);
  });
});
