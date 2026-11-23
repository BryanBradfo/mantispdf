// Prerenders every page at build time (postbuild), with no browser: Vercel builds without Chromium.
// Vite's SSR loader reads the TypeScript sources (routes, tools, i18n, structured data) and
// src/seo/build.ts returns the files to write next to the built dist/index.html:
//   dist/<path>/index.html  one per page and locale (the English home replaces dist/index.html),
//                            with title, meta, canonical, hreflang, og:/twitter:, JSON-LD and the
//                            page's content in #root (the app replaces it when it mounts);
//   dist/shell.html          the bare app shell, served by vercel.json for every other path.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const shellPath = join(dist, "index.html");

const shell = readFileSync(shellPath, "utf8");
if (/<\w+ data-prerender/.test(shell)) {
  console.error("prerender: dist/index.html is already prerendered; run vite build first.");
  process.exit(1);
}

const server = await createServer({
  root,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { buildSeoFiles } = await server.ssrLoadModule("/src/seo/build.ts");
  const files = buildSeoFiles(shell);
  for (const { file, content } of files) {
    const out = join(dist, file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, content);
  }
  const pages = files.filter((f) => f.file.endsWith("index.html")).length;
  console.log(`prerender: ${pages} pages, shell.html`);
} finally {
  await server.close();
}
