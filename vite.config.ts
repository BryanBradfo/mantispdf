import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  worker: {
    plugins: () => [wasm(), topLevelAwait()],
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
});
