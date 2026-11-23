/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { VitePWA } from "vite-plugin-pwa";
import {
  runtimeCacheNames,
  runtimeCleanupFile,
  runtimeCleanupScript,
  webManifest,
  workboxOptions,
  type PwaBuildIds,
} from "./src/pwa/config";

// The desktop download links (src/lib/desktopRelease.ts) follow the package version.
const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { version: string };

/**
 * Content id of a public/ runtime folder (names and bytes, md5, 10 hex): the service worker's cache name for
 * it (src/pwa/config.ts). "none" before the prebuild copy (dev, unit tests). scripts/check-pwa.mjs recomputes it
 * on dist/ and fails the build on a mismatch.
 */
function folderId(dir: string): string {
  if (!existsSync(dir)) return "none";
  const hash = createHash("md5");
  const walk = (d: string): string[] =>
    readdirSync(d)
      .sort()
      .flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const file of walk(dir)) hash.update(relative(dir, file).split("\\").join("/")).update("\0").update(readFileSync(file));
  return hash.digest("hex").slice(0, 10);
}

const pwaIds: PwaBuildIds = {
  // The version react-pdf's pdf.js reports (pdfjs.version), which names the worker URL (src/lib/pdfWorkerUrl.ts).
  pdfjsVersion: (JSON.parse(readFileSync(new URL("node_modules/pdfjs-dist/package.json", import.meta.url), "utf8")) as { version: string })
    .version,
  fontsId: folderId(fileURLToPath(new URL("public/fonts-runtime", import.meta.url))),
  ocrId: folderId(fileURLToPath(new URL("public/ocr-runtime", import.meta.url))),
};

/** Emits the script sw.js imports to delete older runtime caches on activate (src/pwa/config.ts). */
function pwaRuntimeCleanup(ids: PwaBuildIds): Plugin {
  const names = runtimeCacheNames(ids);
  return {
    name: "mantis-pwa-runtime-cleanup",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: runtimeCleanupFile(ids), source: runtimeCleanupScript([names.fonts, names.ocr]) });
    },
  };
}

/**
 * `vite preview` serves the prerendered pages as Vercel does (vercel.json): `/fr/merge` gets
 * dist/fr/merge/index.html, any other page-like path the bare shell (dist/shell.html). Without it,
 * preview would answer every path with dist/index.html, the prerendered English home.
 */
function prerenderedPreview(): Plugin {
  return {
    name: "mantis-prerendered-preview",
    configurePreviewServer(server) {
      const dist = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((req, _res, next) => {
        const [pathname, query = ""] = (req.url ?? "/").split("?");
        const wantsHtml = req.method === "GET" || req.method === "HEAD";
        if (!wantsHtml || pathname === "/" || pathname.includes(".")) return next();
        const page = join(pathname.replace(/\/+$/, ""), "index.html");
        const target = existsSync(join(dist, page)) ? page : existsSync(join(dist, "shell.html")) ? "/shell.html" : null;
        if (target) req.url = target + (query ? `?${query}` : "");
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    prerenderedPreview(),
    // Installable web app: dist/manifest.webmanifest (linked from every page) and dist/sw.js. Registered by
    // src/pwa/start.ts (never in Tauri); "prompt": a new version waits for the person (PwaUpdatePanel).
    // KILL SWITCH for a broken service worker: deploy with `selfDestroying: true` added below. sw.js then
    // becomes a worker that unregisters itself, deletes every cache and reloads its open pages from the
    // network; /sw.js is served no-cache (vercel.json), so browsers pick it up on their next visit. Remove
    // the flag in a later deploy to bring the web app back. See CLAUDE.md (PWA).
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: webManifest,
      includeManifestIcons: false,
      workbox: workboxOptions(pwaIds),
    }),
    pwaRuntimeCleanup(pwaIds),
  ],
  define: {
    __MANTIS_VERSION__: JSON.stringify(pkg.version),
  },
  // Tauri's desktop shell loads the dev server at a fixed devUrl
  // (http://localhost:5173), so pin the port and disable fallback. This only
  // affects `vite` dev; `vite build`/`preview` (and the web flow) are unchanged.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "esnext",
  },
  worker: {
    plugins: () => [wasm()],
  },
  resolve: {
    alias: {
      "mantis-wasm": fileURLToPath(
        new URL("crates/mantis-wasm/pkg/mantis_wasm.js", import.meta.url),
      ),
    },
  },
  optimizeDeps: {
    exclude: ["mantis-wasm"],
  },
  test: {
    // jsdom gives unit tests access to File, FileReader, Blob, URL, document.
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Playwright specs live under e2e/ and run via `npm run test:e2e`, not Vitest.
    exclude: ["e2e/**", "node_modules/**"],
  },
});
