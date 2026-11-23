import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PWA_ICONS, RUNTIME_CACHES, SHELL_URL, SHORTCUTS, webManifest, workboxOptions } from "./config";
import { SHELL_FILE } from "../seo/build";
import { TOOLS } from "../lib/tools";
import common from "../i18n/locales/en/common";

const publicDir = resolve(__dirname, "../../public");

describe("web app manifest", () => {
  it("meets the install criteria: name, start_url, display, colours, 192 and 512 icons", () => {
    expect(webManifest).toMatchObject({
      id: "/",
      name: "MantisPDF",
      short_name: "MantisPDF",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#000000",
      theme_color: "#000000",
      categories: ["productivity", "utilities"],
    });
    const sizes = webManifest.icons!.map((i) => `${i.sizes} ${i.purpose}`);
    expect(sizes).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
  });

  it("describes the app with the slogan", () => {
    expect(webManifest.description).toBe(common.footerSlogan);
  });

  it("lists icons that npm run brand wrote to public/", () => {
    const files = [...Object.values(PWA_ICONS), ...SHORTCUTS.map((s) => s.icon)];
    for (const f of files) expect(existsSync(resolve(publicDir, f)), f).toBe(true);
    for (const icon of webManifest.icons!) expect(existsSync(resolve(publicDir, icon.src.slice(1))), icon.src).toBe(true);
  });

  it("offers four tool shortcuts, each a real tool page with a 96 px icon", () => {
    const hrefs = TOOLS.map((t) => t.href);
    expect(webManifest.shortcuts!.map((s) => s.url)).toEqual(["/merge", "/compress", "/edit-pdf", "/compare"]);
    for (const s of webManifest.shortcuts!) {
      expect(hrefs).toContain(s.url);
      expect(s.icons).toEqual([expect.objectContaining({ sizes: "96x96", type: "image/png" })]);
    }
    expect(webManifest.shortcuts!.map((s) => s.name)).toEqual(["Merge PDF", "Compress PDF", "Edit PDF", "Compare PDF"]);
  });

  it("has no middle dot or em dash", () => {
    expect(JSON.stringify(webManifest)).not.toMatch(/[·—]/);
  });
});

describe("service worker options", () => {
  it("falls back to the prerender's shell", () => {
    expect(SHELL_URL).toBe(SHELL_FILE);
  });

  it("never precaches the runtime fonts or the OCR runtime", () => {
    const globs = workboxOptions.globPatterns!.join(" ");
    expect(globs).not.toMatch(/fonts-runtime|ocr-runtime|\*\*\/\*\.(ttf|gz)/);
    expect(globs).not.toMatch(/^\*\*/);
  });

  it("precaches the app code, the WASM, the UI fonts and the pdf.js worker", () => {
    expect(workboxOptions.globPatterns).toEqual(
      expect.arrayContaining(["assets/**/*.{js,css,wasm,woff2}", "pdf.worker.min.mjs", "favicon.svg"]),
    );
    expect(workboxOptions.navigateFallback).toBeNull();
  });

  it("waits for the person before activating a new version", () => {
    expect(workboxOptions.skipWaiting).toBe(false);
    expect(workboxOptions.clientsClaim).toBe(false);
  });

  // Workbox copies each callback into sw.js as source text, so it must not close over module variables.
  const routes = workboxOptions.runtimeCaching!;
  const match = (i: number, href: string, extra: Record<string, unknown> = {}) => {
    const source = String(routes[i].urlPattern);
    const fn = new Function(`return (${source});`)() as (o: unknown) => boolean;
    const url = new URL(href);
    return Boolean(fn({ url, sameOrigin: url.origin === "https://mantispdf.app", ...extra }));
  };

  it("sends navigations to the network, with the precached shell offline", () => {
    expect(routes[0]).toMatchObject({ handler: "NetworkOnly", options: { precacheFallback: { fallbackURL: SHELL_URL } } });
    expect(match(0, "https://mantispdf.app/merge", { request: { mode: "navigate" } })).toBe(true);
    expect(match(0, "https://mantispdf.app/assets/x.js", { request: { mode: "cors" } })).toBe(false);
  });

  it("caches each runtime folder on first use, same origin only", () => {
    RUNTIME_CACHES.forEach(({ prefix, cacheName }, k) => {
      const i = k + 1;
      expect(routes[i]).toMatchObject({ handler: "CacheFirst", options: { cacheName } });
      expect(match(i, `https://mantispdf.app${prefix}file.bin`)).toBe(true);
      expect(match(i, `https://elsewhere.example${prefix}file.bin`)).toBe(false);
      expect(match(i, "https://mantispdf.app/assets/file.bin")).toBe(false);
    });
  });
});
