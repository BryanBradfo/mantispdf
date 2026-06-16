/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [react(), wasm()],
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
