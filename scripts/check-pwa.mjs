// Postbuild check of the installable web app in dist/ (run after the prerender):
// - manifest.webmanifest has the install fields and every icon it lists exists;
// - every page links the manifest;
// - sw.js precaches the shell under shell.html with the revision of the real dist/shell.html (the service
//   worker is written before the prerender, from dist/index.html, see src/pwa/config.ts), and never the
//   runtime folders (fonts-runtime, ocr-runtime), which are cached on first use instead.
// Usage: node scripts/check-pwa.mjs [dist]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "dist");
const problems = [];
const read = (rel) => readFileSync(join(dist, rel), "utf8");

const manifest = JSON.parse(read("manifest.webmanifest"));
for (const key of ["name", "short_name", "start_url", "display", "id", "background_color", "theme_color"])
  if (!manifest[key]) problems.push(`manifest: no ${key}`);
const icons = [...(manifest.icons ?? []), ...(manifest.shortcuts ?? []).flatMap((s) => s.icons ?? [])];
for (const size of ["192x192", "512x512"])
  if (!manifest.icons?.some((i) => i.sizes === size && (i.purpose ?? "any").includes("any"))) problems.push(`manifest: no ${size} icon`);
if (!manifest.icons?.some((i) => i.purpose === "maskable")) problems.push("manifest: no maskable icon");
for (const icon of icons) if (!existsSync(join(dist, icon.src))) problems.push(`manifest: icon ${icon.src} is missing`);

for (const page of ["index.html", "shell.html", "merge/index.html", "fr/download/index.html"])
  if (!read(page).includes('<link rel="manifest" href="/manifest.webmanifest">')) problems.push(`${page}: no manifest link`);

const sw = read("sw.js");
const entries = [...sw.matchAll(/\{url:"([^"]+)",revision:(null|"[0-9a-f]+")\}/g)].map((m) => ({ url: m[1], revision: m[2] }));
if (entries.length === 0) problems.push("sw.js: no precache entries found");
const shell = entries.find((e) => e.url === "shell.html");
const shellHash = createHash("md5").update(readFileSync(join(dist, "shell.html"))).digest("hex");
if (!shell) problems.push("sw.js: shell.html is not precached");
else if (shell.revision !== `"${shellHash}"`) problems.push("sw.js: the precached shell.html revision does not match dist/shell.html");
for (const e of entries) {
  if (/^(fonts-runtime|ocr-runtime)\//.test(e.url)) problems.push(`sw.js: precaches ${e.url}`);
  if (!existsSync(join(dist, e.url))) problems.push(`sw.js: precaches ${e.url}, which is not in dist`);
}
if (entries.some((e) => /(^|\/)index\.html$/.test(e.url))) problems.push("sw.js: precaches a prerendered page");
for (const needed of ["pdf.worker.min.mjs", "favicon.svg"])
  if (!entries.some((e) => e.url === needed)) problems.push(`sw.js: ${needed} is not precached`);
if (!entries.some((e) => /^assets\/.+\.wasm$/.test(e.url))) problems.push("sw.js: the WASM engine is not precached");
if (!/fonts-runtime\//.test(sw) || !/ocr-runtime\//.test(sw)) problems.push("sw.js: no runtime cache for fonts-runtime / ocr-runtime");

if (problems.length) {
  console.error(`PWA check failed in ${dist}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const bytes = entries.reduce((sum, e) => sum + statSync(join(dist, e.url)).size, 0);
console.log(`PWA: manifest and ${icons.length} icons, sw.js precaches ${entries.length} files (${(bytes / 1048576).toFixed(1)} MB) in ${dist}`);
