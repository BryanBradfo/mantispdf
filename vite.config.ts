import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [react(), wasm()],
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
});
