// Build the Tauri updater manifest (latest.json) of a GitHub release from its uploaded assets, once
// every platform build is done (the Release workflow's publish job). One writer, so no race between
// the parallel matrix builds.
//
//   node scripts/release-latest-json.mjs --tag v2.1.0 --repo owner/name --assets assets.txt \
//     --sigs <dir of downloaded .sig files> [--notes "..."] --out latest.json
//
// assets.txt lists the release's asset names, one per line. Exits 1 (and writes nothing) when one of
// the four base platforms (macOS arm64 and x64, Windows NSIS, Linux AppImage) is missing or unsigned.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Updater platform keys and the asset that serves each. `required`: the release is not published
 * without it. Keys sharing a pattern point at the same asset (the updater tries `os-arch-installer`
 * first, then `os-arch`).
 */
export const PLATFORMS = [
  { keys: ["darwin-aarch64"], pattern: /_aarch64\.app\.tar\.gz$/, required: true },
  { keys: ["darwin-x86_64"], pattern: /_(x64|x86_64)\.app\.tar\.gz$/, required: true },
  { keys: ["windows-x86_64", "windows-x86_64-nsis"], pattern: /-setup\.exe$/, required: true },
  { keys: ["windows-x86_64-msi"], pattern: /\.msi$/, required: false },
  { keys: ["linux-x86_64", "linux-x86_64-appimage"], pattern: /\.AppImage$/, required: true },
  { keys: ["linux-x86_64-deb"], pattern: /\.deb$/, required: false },
  { keys: ["linux-x86_64-rpm"], pattern: /\.rpm$/, required: false },
];

/**
 * The manifest, or `{ errors }`. `assets`: asset names on the release; `readSig(name)`: the content of
 * `<name>.sig` (only called for signatures that are on the release).
 */
export function buildLatestJson({ tag, repo, notes = "", pubDate = new Date(), assets, readSig }) {
  const names = new Set(assets);
  const errors = [];
  const platforms = {};
  for (const { keys, pattern, required } of PLATFORMS) {
    const candidates = assets.filter((a) => pattern.test(a) && names.has(`${a}.sig`));
    const label = keys[0];
    if (candidates.length > 1) {
      errors.push(`${label}: several signed assets match (${candidates.join(", ")})`);
      continue;
    }
    if (candidates.length === 0) {
      if (required) errors.push(`${label}: no signed asset (expected a name matching ${pattern} and its .sig)`);
      continue;
    }
    const asset = candidates[0];
    const signature = String(readSig(`${asset}.sig`) ?? "").trim();
    if (!signature) {
      errors.push(`${label}: ${asset}.sig is empty`);
      continue;
    }
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
    for (const key of keys) platforms[key] = { signature, url };
  }
  if (errors.length > 0) return { errors };
  return {
    manifest: {
      version: tag.replace(/^v/, ""),
      notes: notes.trim(),
      pub_date: pubDate.toISOString().replace(/\.\d{3}Z$/, "Z"),
      platforms,
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  for (const k of ["tag", "repo", "assets", "sigs", "out"]) if (!args[k]) throw new Error(`missing --${k}`);
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const assets = readFileSync(args.assets, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const result = buildLatestJson({
    tag: args.tag,
    repo: args.repo,
    notes: args.notes ?? "",
    assets,
    readSig: (name) => readFileSync(join(args.sigs, name), "utf8"),
  });
  if (result.errors) {
    for (const e of result.errors) console.error(`latest.json: ${e}`);
    process.exit(1);
  }
  writeFileSync(args.out, `${JSON.stringify(result.manifest, null, 2)}\n`);
  console.log(`latest.json: ${Object.keys(result.manifest.platforms).join(", ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
