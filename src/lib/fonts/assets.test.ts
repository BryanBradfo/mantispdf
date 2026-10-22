// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FONT_FILES,
  FONT_LICENSE_FILES,
  RUNTIME_DIR,
  buildManifest,
  fontLicenseSources,
  fontSources,
  missingInDist,
  readCmapRanges,
  // @ts-expect-error: a plain Node script without type declarations.
} from "../../../scripts/copy-font-assets.mjs";
import { FONT_BASE, parseManifest } from "./manifest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

type Range = [number, number];
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A minimal sfnt holding only a cmap table made of the given subtables. */
function sfnt(subtables: { platform: number; encoding: number; body: number[] }[]): Uint8Array {
  const header = [...u16(0), ...u16(subtables.length)];
  let offset = 4 + 8 * subtables.length;
  const records: number[] = [];
  const bodies: number[] = [];
  for (const s of subtables) {
    records.push(...u16(s.platform), ...u16(s.encoding), ...u32(offset));
    bodies.push(...s.body);
    offset += s.body.length;
  }
  const cmap = [...header, ...records, ...bodies];
  const dir = [...u32(0x00010000), ...u16(1), ...u16(16), ...u16(0), ...u16(0)];
  const entry = [...Array.from("cmap", (c) => c.charCodeAt(0)), ...u32(0), ...u32(12 + 16), ...u32(cmap.length)];
  return Uint8Array.from([...dir, ...entry, ...cmap]);
}

function format4(segments: { start: number; end: number; delta: number; glyphs?: number[] }[]): number[] {
  const segs = [...segments, { start: 0xffff, end: 0xffff, delta: 1 }];
  const n = segs.length;
  const glyphArray: number[] = [];
  const idRangeOffset: number[] = [];
  segs.forEach((s, i) => {
    if (s.glyphs) {
      idRangeOffset.push(2 * (n - i) + 2 * glyphArray.length);
      glyphArray.push(...s.glyphs);
    } else idRangeOffset.push(0);
  });
  const body = [
    ...u16(2 * n), ...u16(0), ...u16(0), ...u16(0),
    ...segs.flatMap((s) => u16(s.end)), ...u16(0),
    ...segs.flatMap((s) => u16(s.start)),
    ...segs.flatMap((s) => u16(s.delta & 0xffff)),
    ...idRangeOffset.flatMap(u16),
    ...glyphArray.flatMap(u16),
  ];
  return [...u16(4), ...u16(6 + body.length), ...u16(0), ...body];
}

function format12(groups: [number, number, number][]): number[] {
  const body = groups.flatMap(([s, e, g]) => [...u32(s), ...u32(e), ...u32(g)]);
  return [...u16(12), ...u16(0), ...u32(16 + body.length), ...u32(0), ...u32(groups.length), ...body];
}

describe("readCmapRanges", () => {
  it("reads a format 4 subtable, merging adjacent codes and skipping the terminator", () => {
    const font = sfnt([{ platform: 3, encoding: 1, body: format4([{ start: 0x20, end: 0x7e, delta: -0x1f }, { start: 0x7f, end: 0x80, delta: -0x1f }, { start: 0x400, end: 0x40f, delta: 5 }]) }]);
    expect(readCmapRanges(font) as Range[]).toEqual([[0x20, 0x80], [0x400, 0x40f]]);
  });

  it("follows idRangeOffset and skips codes that map to glyph 0", () => {
    const font = sfnt([{ platform: 3, encoding: 1, body: format4([{ start: 0x41, end: 0x45, delta: 0, glyphs: [7, 0, 9, 10, 0] }]) }]);
    expect(readCmapRanges(font) as Range[]).toEqual([[0x41, 0x41], [0x43, 0x44]]);
  });

  it("reads a format 12 subtable above the BMP", () => {
    const font = sfnt([{ platform: 3, encoding: 10, body: format12([[0x41, 0x5a, 3], [0x20000, 0x2a6df, 100]]) }]);
    expect(readCmapRanges(font) as Range[]).toEqual([[0x41, 0x5a], [0x20000, 0x2a6df]]);
  });

  it("unions several Unicode subtables and ignores symbol and Mac ones", () => {
    const font = sfnt([
      { platform: 1, encoding: 0, body: format4([{ start: 0x30, end: 0x39, delta: 1 }]) },
      { platform: 3, encoding: 1, body: format4([{ start: 0x41, end: 0x42, delta: 1 }]) },
      { platform: 3, encoding: 10, body: format12([[0x1f600, 0x1f601, 5]]) },
    ]);
    expect(readCmapRanges(font) as Range[]).toEqual([[0x41, 0x42], [0x1f600, 0x1f601]]);
  });

  it("throws a clear error on bytes that are not a TrueType font", () => {
    expect(() => readCmapRanges(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow(/sfnt|cmap/i);
    expect(() => readCmapRanges(new Uint8Array(0))).toThrow();
  });
});

describe("self-hosted font assets", () => {
  it("are served from /fonts-runtime/", () => {
    expect(FONT_BASE).toBe("/fonts-runtime");
    expect(`/${RUNTIME_DIR as string}`).toBe(FONT_BASE);
  });

  it("ships Regular and Bold for the Latin and script families, Regular only for CJK", () => {
    const files = FONT_FILES as string[];
    for (const f of ["NotoSans", "NotoSerif", "NotoSansMono", "NotoSansArabic", "NotoSansHebrew", "NotoSansDevanagari", "NotoSansThai"]) {
      expect(files, f).toContain(`${f}_400Regular.ttf`);
      expect(files, f).toContain(`${f}_700Bold.ttf`);
    }
    for (const f of ["NotoSansSC", "NotoSansTC", "NotoSansJP", "NotoSansKR"]) {
      expect(files, f).toContain(`${f}_400Regular.ttf`);
      expect(files, f).not.toContain(`${f}_700Bold.ttf`);
    }
    expect(files).toHaveLength(7 * 2 + 4);
  });

  it("every source and licence exists in the installed packages", () => {
    for (const [dest, src] of Object.entries({ ...fontSources(ROOT), ...fontLicenseSources(ROOT) }) as [string, string][]) {
      expect(existsSync(src), dest).toBe(true);
      expect(statSync(src).size, dest).toBeGreaterThan(0);
    }
    expect([...(FONT_LICENSE_FILES as string[])]).toContain("NOTICE.md");
  });

  it("computes the covered ranges from each real font's cmap", () => {
    const manifest = parseManifest(buildManifest(ROOT));
    const sans = manifest.fonts.find((f) => f.file === "NotoSans_400Regular.ttf");
    const sc = manifest.fonts.find((f) => f.file === "NotoSansSC_400Regular.ttf");
    expect(sans).toMatchObject({ family: "Noto Sans", weight: 400 });
    expect(sc).toMatchObject({ family: "Noto Sans SC", weight: 400 });
    const covers = (f: typeof sans, cp: number) => f!.ranges.some(([a, b]) => cp >= a && cp <= b);
    expect(covers(sans, "e".codePointAt(0)!)).toBe(true);
    expect(covers(sans, 0x416)).toBe(true); // Cyrillic
    expect(covers(sans, 0x4e2d)).toBe(false);
    expect(covers(sc, 0x4e2d)).toBe(true);
    expect(sans!.size).toBe(statSync(fontSources(ROOT)["NotoSans_400Regular.ttf"] as string).size);
  });

  it("the postbuild check requires every font, the licences and the manifest", () => {
    const dist = mkdtempSync(join(tmpdir(), "fonts-dist-"));
    try {
      const required = [...(FONT_FILES as string[]), ...(FONT_LICENSE_FILES as string[]), "fonts.json"].map((f) => `${RUNTIME_DIR as string}/${f}`);
      expect(missingInDist(dist) as string[]).toEqual(required);
      for (const f of required) {
        mkdirSync(dirname(join(dist, f)), { recursive: true });
        writeFileSync(join(dist, f), "x");
      }
      expect(missingInDist(dist) as string[]).toEqual([]);
      writeFileSync(join(dist, required[0]!), "");
      expect(missingInDist(dist) as string[]).toEqual([required[0]]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
