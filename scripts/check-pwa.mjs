// Postbuild check of the installable web app in dist/ (run after the prerender):
// - manifest.webmanifest has the install fields and every icon it lists exists;
// - every page links the manifest;
// - sw.js precaches the shell under shell.html with the revision of the real dist/shell.html (the service
//   worker is written before the prerender, from dist/index.html, see src/pwa/config.ts), and never the
//   runtime folders (fonts-runtime, ocr-runtime), which are cached on first use instead.
// - the pdf.js worker is precached under its versioned URL (src/lib/pdfWorkerUrl.ts), for the pdf.js version
//   the worker file and node_modules/pdfjs-dist carry;
// - each runtime cache name carries the content id of its dist/ folder (same hash as vite.config.ts folderId),
//   and the cleanup script sw.js imports exists and keeps exactly those names.
// Usage: node scripts/check-pwa.mjs [dist]
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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
const fileOf = (url) => url.split("?")[0];
for (const e of entries) {
  if (/^(fonts-runtime|ocr-runtime)\//.test(e.url)) problems.push(`sw.js: precaches ${e.url}`);
  if (!existsSync(join(dist, fileOf(e.url)))) problems.push(`sw.js: precaches ${e.url}, which is not in dist`);
}

const pdfjsVersion = JSON.parse(readFileSync(resolve("node_modules/pdfjs-dist/package.json"), "utf8")).version;
const workerUrl = `pdf.worker.min.mjs?v=${pdfjsVersion}`;
if (!entries.some((e) => e.url === workerUrl)) problems.push(`sw.js: the pdf.js worker is not precached as ${workerUrl}`);
if (!readFileSync(join(dist, "pdf.worker.min.mjs"), "utf8").includes(`"${pdfjsVersion}"`))
  problems.push(`dist/pdf.worker.min.mjs is not pdf.js ${pdfjsVersion}`);

/** Same as vite.config.ts folderId. */
function folderId(dir) {
  if (!existsSync(dir)) return "none";
  const hash = createHash("md5");
  const walk = (d) =>
    readdirSync(d)
      .sort()
      .flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const file of walk(dir)) hash.update(relative(dir, file).split("\\").join("/")).update("\0").update(readFileSync(file));
  return hash.digest("hex").slice(0, 10);
}
const fontsCache = `mantis-fonts-runtime-${folderId(join(dist, "fonts-runtime"))}`;
const ocrCache = `mantis-ocr-runtime-${folderId(join(dist, "ocr-runtime"))}`;
for (const name of [fontsCache, ocrCache]) if (!sw.includes(`cacheName:"${name}"`)) problems.push(`sw.js: no runtime cache named ${name}`);
const imported = /importScripts\("([^"]+)"\)/.exec(sw)?.[1];
if (!imported || !existsSync(join(dist, imported))) problems.push("sw.js: the runtime cache cleanup script is missing");
else if (!read(imported).includes(JSON.stringify([fontsCache, ocrCache]))) problems.push(`${imported}: does not keep the current runtime caches`);
if ((sw.match(/purgeOnQuotaError:!0/g) ?? []).length !== 2) problems.push("sw.js: runtime caches do not purge on quota errors");
if (entries.some((e) => /(^|\/)index\.html$/.test(e.url))) problems.push("sw.js: precaches a prerendered page");
for (const needed of ["favicon.svg"])
  if (!entries.some((e) => e.url === needed)) problems.push(`sw.js: ${needed} is not precached`);
if (!entries.some((e) => /^assets\/.+\.wasm$/.test(e.url))) problems.push("sw.js: the WASM engine is not precached");
if (!/fonts-runtime\//.test(sw) || !/ocr-runtime\//.test(sw)) problems.push("sw.js: no runtime cache for fonts-runtime / ocr-runtime");

if (problems.length) {
  console.error(`PWA check failed in ${dist}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const bytes = entries.reduce((sum, e) => sum + statSync(join(dist, fileOf(e.url))).size, 0);
console.log(`PWA: manifest and ${icons.length} icons, sw.js precaches ${entries.length} files (${(bytes / 1048576).toFixed(1)} MB) in ${dist}`);
