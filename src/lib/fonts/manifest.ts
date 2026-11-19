/** Where the self-hosted fonts are served (public/fonts-runtime, filled by scripts/copy-font-assets.mjs). */
export const FONT_BASE = "/fonts-runtime";

export interface FontEntry {
  /** File name under FONT_BASE, no path. */
  file: string;
  family: string;
  weight: 400 | 700;
  /** Size of the file in bytes. */
  size: number;
  /** Covered code points: sorted, non-overlapping inclusive [start, end] ranges. */
  ranges: [number, number][];
}

export interface FontManifest {
  version: 1;
  fonts: FontEntry[];
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** A file name is a bare name: no directory, no scheme, no parent reference. */
export function isFontFileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

export function fontUrl(file: string): string {
  return `${FONT_BASE}/${file}`;
}

function parseEntry(raw: unknown, index: number): FontEntry {
  const bad = (why: string): never => {
    throw new Error(`Invalid font manifest: fonts[${index}] ${why}`);
  };
  if (typeof raw !== "object" || raw === null) return bad("is not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.file !== "string" || !isFontFileName(r.file)) return bad("has an invalid file name");
  if (typeof r.family !== "string" || r.family === "") return bad("has no family");
  if (r.weight !== 400 && r.weight !== 700) return bad("has an invalid weight");
  if (!isInt(r.size) || r.size <= 0) return bad("has an invalid size");
  if (!Array.isArray(r.ranges)) return bad("has no ranges");
  const ranges: [number, number][] = [];
  let previousEnd = -1;
  for (const pair of r.ranges as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isInt(pair[0]) || !isInt(pair[1])) return bad("has a malformed range");
    const [a, b] = pair as [number, number];
    if (a < 0 || b < a || b > 0x10ffff || a <= previousEnd) return bad("has ranges that are reversed, overlapping or unsorted");
    ranges.push([a, b]);
    previousEnd = b;
  }
  return { file: r.file, family: r.family, weight: r.weight, size: r.size, ranges };
}

/** Validate untrusted JSON (fonts.json) into a FontManifest, or throw. */
export function parseManifest(raw: unknown): FontManifest {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid font manifest: not an object");
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) throw new Error("Invalid font manifest: unsupported version");
  if (!Array.isArray(r.fonts)) throw new Error("Invalid font manifest: fonts is not a list");
  return { version: 1, fonts: (r.fonts as unknown[]).map(parseEntry) };
}

/** True when the font has a glyph for the code point (binary search over the sorted ranges). */
export function fontCovers(font: FontEntry, codePoint: number): boolean {
  let lo = 0;
  let hi = font.ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = font.ranges[mid]!;
    if (codePoint < a) hi = mid - 1;
    else if (codePoint > b) lo = mid + 1;
    else return true;
  }
  return false;
}
