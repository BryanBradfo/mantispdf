import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  PWA_ICONS,
  SHELL_URL,
  SHORTCUTS,
  runtimeCacheNames,
  runtimeCleanupFile,
  runtimeCleanupScript,
  webManifest,
  workboxOptions as workboxFor,
} from "./config";
import { pdfWorkerPath } from "../lib/pdfWorkerUrl";
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

const IDS = { pdfjsVersion: "4.8.69", fontsId: "f0f0f0f0f0", ocrId: "0c0c0c0c0c" };
const workboxOptions = workboxFor(IDS);

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

  it("caches each runtime folder on first use, same origin only, in a cache named after its content", () => {
    const names = runtimeCacheNames(IDS);
    expect(names).toEqual({ fonts: "mantis-fonts-runtime-f0f0f0f0f0", ocr: "mantis-ocr-runtime-0c0c0c0c0c" });
    (
      [
        ["/fonts-runtime/", names.fonts, 40],
        ["/ocr-runtime/", names.ocr, 30],
      ] as const
    ).forEach(([prefix, cacheName, maxEntries], k) => {
      const i = k + 1;
      expect(routes[i]).toMatchObject({
        handler: "CacheFirst",
        options: { cacheName, expiration: { maxEntries, purgeOnQuotaError: true }, cacheableResponse: { statuses: [200] } },
      });
      expect(match(i, `https://mantispdf.app${prefix}file.bin`)).toBe(true);
      expect(match(i, `https://elsewhere.example${prefix}file.bin`)).toBe(false);
      expect(match(i, "https://mantispdf.app/assets/file.bin")).toBe(false);
    });
  });

  it("a change in a runtime folder renames its cache, and only that one", () => {
    const next = runtimeCacheNames({ ...IDS, fontsId: "1111111111" });
    expect(next.fonts).not.toBe(runtimeCacheNames(IDS).fonts);
    expect(next.ocr).toBe(runtimeCacheNames(IDS).ocr);
    expect(runtimeCleanupFile({ ...IDS, fontsId: "1111111111" })).not.toBe(runtimeCleanupFile(IDS));
    expect(workboxOptions.importScripts).toEqual([runtimeCleanupFile(IDS)]);
  });

  it("the cleanup script deletes older runtime caches on activate and keeps everything else", async () => {
    const names = runtimeCacheNames(IDS);
    const store = new Set([
      "mantis-fonts-runtime",
      "mantis-fonts-runtime-aaaaaaaaaa",
      names.fonts,
      "mantis-ocr-runtime-bbbbbbbbbb",
      names.ocr,
      "workbox-precache-v2-https://mantispdf.app/",
    ]);
    let onActivate: ((e: { waitUntil(p: Promise<unknown>): void }) => void) | undefined;
    const self = { addEventListener: (type: string, l: typeof onActivate) => type === "activate" && (onActivate = l) };
    const caches = { keys: async () => [...store], delete: async (n: string) => store.delete(n) };
    new Function("self", "caches", runtimeCleanupScript([names.fonts, names.ocr]))(self, caches);
    let done: Promise<unknown> = Promise.resolve();
    onActivate!({ waitUntil: (p) => (done = p) });
    await done;
    expect([...store]).toEqual([names.fonts, names.ocr, "workbox-precache-v2-https://mantispdf.app/"]);
  });

  it("precaches the pdf.js worker under the versioned URL the app requests", async () => {
    const transform = workboxOptions.manifestTransforms[0];
    const { manifest } = await transform([
      { url: "index.html", revision: "a", size: 1 },
      { url: "pdf.worker.min.mjs", revision: "b", size: 2 },
      { url: "assets/x.js", revision: null, size: 3 },
    ]);
    expect(manifest.map((e) => e.url)).toEqual([SHELL_URL, "pdf.worker.min.mjs?v=4.8.69", "assets/x.js"]);
    expect(`/${manifest[1].url}`).toBe(pdfWorkerPath("4.8.69"));
  });
});
