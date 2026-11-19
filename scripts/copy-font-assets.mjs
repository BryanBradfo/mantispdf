// Copy the Noto fonts used for Unicode text in Edit PDF and Fill form from node_modules into
// public/fonts-runtime/ so they are served from the app origin and fetched lazily, and generate
// fonts.json: file, family, weight, size and the Unicode ranges each file covers (read from its
// cmap). Licences and a NOTICE are copied next to them.
//
//   node scripts/copy-font-assets.mjs            copy into public/fonts-runtime (pre{dev,build} hook)
//   node scripts/copy-font-assets.mjs --check D  fail unless D holds every font, the licences and
//                                                fonts.json (postbuild)
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Served at /fonts-runtime/. Mirrors FONT_BASE in src/lib/fonts/manifest.ts. */
export const RUNTIME_DIR = "fonts-runtime";

/** npm package (under @expo-google-fonts), file prefix, family name, weights shipped. */
const FAMILIES = [
  ["noto-sans", "NotoSans", "Noto Sans", [400, 700]],
  ["noto-serif", "NotoSerif", "Noto Serif", [400, 700]],
  ["noto-sans-mono", "NotoSansMono", "Noto Sans Mono", [400, 700]],
  ["noto-sans-arabic", "NotoSansArabic", "Noto Sans Arabic", [400, 700]],
  ["noto-sans-hebrew", "NotoSansHebrew", "Noto Sans Hebrew", [400, 700]],
  ["noto-sans-devanagari", "NotoSansDevanagari", "Noto Sans Devanagari", [400, 700]],
  ["noto-sans-thai", "NotoSansThai", "Noto Sans Thai", [400, 700]],
  // CJK is Regular only (about 30 MB in all): bold is drawn with a stroke.
  ["noto-sans-sc", "NotoSansSC", "Noto Sans SC", [400]],
  ["noto-sans-tc", "NotoSansTC", "Noto Sans TC", [400]],
  ["noto-sans-jp", "NotoSansJP", "Noto Sans JP", [400]],
  ["noto-sans-kr", "NotoSansKR", "Noto Sans KR", [400]],
];

const WEIGHT_DIR = { 400: "400Regular", 700: "700Bold" };

const fileName = (prefix, weight) => `${prefix}_${WEIGHT_DIR[weight]}.ttf`;

/** Destination file name (relative to public/fonts-runtime) to source (absolute), for the project at `root`. */
export function fontSources(root) {
  const map = {};
  for (const [pkg, prefix, , weights] of FAMILIES) {
    for (const w of weights) map[fileName(prefix, w)] = join(root, "node_modules/@expo-google-fonts", pkg, WEIGHT_DIR[w], fileName(prefix, w));
  }
  return map;
}

export const FONT_FILES = Object.keys(fontSources("/"));

/** Licence files and the notice copied next to the fonts: destination to source. */
export function fontLicenseSources(root) {
  const map = { "NOTICE.md": join(root, "scripts/fonts-NOTICE.md") };
  for (const [pkg] of FAMILIES) map[`licenses/${pkg}.LICENSE_FONT`] = join(root, "node_modules/@expo-google-fonts", pkg, "LICENSE_FONT");
  return map;
}

export const FONT_LICENSE_FILES = Object.keys(fontLicenseSources("/"));

/**
 * Covered code points of a TrueType font as sorted, merged inclusive [start, end] ranges, from the
 * Unicode subtables of its cmap (format 4 and 12). Codes that map to glyph 0 are not covered.
 */
export function readCmapRanges(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (why) => {
    throw new Error(`Not a usable sfnt font: ${why}`);
  };
  if (bytes.byteLength < 12) fail("too short");
  const tag = view.getUint32(0);
  if (tag !== 0x00010000 && tag !== 0x74727565 && tag !== 0x4f54544f) fail("bad sfnt signature");
  let cmap = -1;
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + 16 * i;
    if (rec + 16 > bytes.byteLength) fail("truncated table directory");
    if (view.getUint32(rec) === 0x636d6170) cmap = view.getUint32(rec + 8);
  }
  if (cmap < 0 || cmap + 4 > bytes.byteLength) fail("no cmap table");
  const covered = [];
  const mark = (from, to) => covered.push([from, to]);
  const count = view.getUint16(cmap + 2);
  for (let i = 0; i < count; i++) {
    const rec = cmap + 4 + 8 * i;
    const platform = view.getUint16(rec);
    const encoding = view.getUint16(rec + 2);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const sub = cmap + view.getUint32(rec + 4);
    const format = view.getUint16(sub);
    if (format === 4) readFormat4(view, sub, mark);
    else if (format === 12) readFormat12(view, sub, mark);
  }
  return mergeRanges(covered);
}

function readFormat4(view, sub, mark) {
  const segCount = view.getUint16(sub + 6) / 2;
  const end = sub + 14;
  const start = end + 2 * segCount + 2;
  const delta = start + 2 * segCount;
  const offset = delta + 2 * segCount;
  for (let s = 0; s < segCount; s++) {
    const last = view.getUint16(end + 2 * s);
    const first = view.getUint16(start + 2 * s);
    const d = view.getUint16(delta + 2 * s);
    const ro = view.getUint16(offset + 2 * s);
    for (let c = first; c <= last && c < 0xffff; c++) {
      let gid;
      if (ro === 0) gid = (c + d) & 0xffff;
      else {
        const at = offset + 2 * s + ro + 2 * (c - first);
        if (at + 2 > view.byteLength) break;
        gid = view.getUint16(at);
        if (gid !== 0) gid = (gid + d) & 0xffff;
      }
      if (gid !== 0) mark(c, c);
    }
  }
}

function readFormat12(view, sub, mark) {
  const groups = view.getUint32(sub + 12);
  for (let g = 0; g < groups; g++) {
    const at = sub + 16 + 12 * g;
    if (at + 12 > view.byteLength) break;
    const first = view.getUint32(at);
    const last = view.getUint32(at + 4);
    const gid = view.getUint32(at + 8);
    if (last < first || last > 0x10ffff) continue;
    // Glyph 0 can only be the first code of a group; start after it.
    mark(gid === 0 ? first + 1 : first, last);
  }
}

function mergeRanges(ranges) {
  const sorted = ranges.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const prev = out[out.length - 1];
    if (prev && a <= prev[1] + 1) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The fonts.json content for the project at `root`: one entry per shipped file, ranges from its cmap. */
export function buildManifest(root) {
  const sources = fontSources(root);
  const fonts = [];
  for (const [, prefix, family, weights] of FAMILIES) {
    for (const weight of weights) {
      const file = fileName(prefix, weight);
      const bytes = readFileSync(sources[file]);
      fonts.push({ file, family, weight, size: bytes.byteLength, ranges: readCmapRanges(bytes) });
    }
  }
  return { version: 1, fonts };
}

/** Files the build output `dist` lacks (or has empty), relative to it. */
export function missingInDist(dist) {
  const required = [...FONT_FILES, ...FONT_LICENSE_FILES, "fonts.json"].map((f) => `${RUNTIME_DIR}/${f}`);
  return required.filter((f) => !existsSync(join(dist, f)) || statSync(join(dist, f)).size === 0);
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const check = process.argv.indexOf("--check");
  if (check !== -1) {
    const dist = join(root, process.argv[check + 1] ?? "dist");
    const missing = missingInDist(dist);
    if (missing.length) {
      console.error(`Missing in ${dist}: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log(`All fonts, their licences and fonts.json are present in ${dist}`);
    return;
  }
  const dest = join(root, "public", RUNTIME_DIR);
  let bytes = 0;
  for (const [rel, src] of Object.entries({ ...fontSources(root), ...fontLicenseSources(root) })) {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(src, to);
    bytes += statSync(to).size;
  }
  const manifest = join(dest, "fonts.json");
  writeFileSync(manifest, JSON.stringify(buildManifest(root)));
  bytes += statSync(manifest).size;
  console.log(`Copied ${FONT_FILES.length} fonts, their licences and fonts.json to public/${RUNTIME_DIR} (${(bytes / 1e6).toFixed(1)} MB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
