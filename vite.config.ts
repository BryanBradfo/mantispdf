/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { VitePWA } from "vite-plugin-pwa";
import { webManifest, workboxOptions } from "./src/pwa/config";

// The desktop download links (src/lib/desktopRelease.ts) follow the package version.
const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { version: string };

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
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: webManifest,
      includeManifestIcons: false,
      workbox: workboxOptions,
    }),
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
