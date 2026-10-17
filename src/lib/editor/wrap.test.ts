import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StdFont } from "../stampJob";
import { ascent, descent, encodeWinAnsi, textWidth, unsupportedChars } from "./afm";
import { AFM_VMETRICS, AFM_WIDTHS } from "./afmWidths";
import { layoutText, wrapLines } from "./wrap";
import vectors from "./wrapVectors.json";

const FONTS: StdFont[] = ["Helvetica", "Helvetica-Bold", "Times-Roman", "Courier"];
const bytes = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe("afmWidths.ts", () => {
  it("has the generator's values for a few glyphs", () => {
    const w = (font: StdFont, code: number) => AFM_WIDTHS[font][code - 32];
    expect(w("Helvetica", 0x80)).toBe(556); // Euro
    expect(w("Helvetica", 39)).toBe(191); // quotesingle
    expect(w("Helvetica-Bold", 39)).toBe(238);
    expect(w("Times-Roman", 39)).toBe(180);
    expect(w("Helvetica", 32)).toBe(278);
    expect(w("Helvetica", 0xa0)).toBe(278); // nbsp = space
    expect(w("Times-Roman", 0x97)).toBe(1000); // emdash
    for (let c = 32; c <= 255; c++) expect(w("Courier", c)).toBe(600);
    expect(AFM_VMETRICS.Helvetica).toEqual({ ascender: 718, descender: -207 });
  });

  it("matches the engine's afm_widths.rs table for table", () => {
    const rust = readFileSync(join(process.cwd(), "crates/mantis-wasm/src/stamp/afm_widths.rs"), "utf8");
    const widths = rust.slice(rust.indexOf("WIDTHS"), rust.indexOf("VMETRICS"));
    const rows = [...widths.matchAll(/\[\s*([\d,\s]+?)\s*\]/g)].map((m) =>
      m[1].split(",").map((v) => v.trim()).filter(Boolean).map(Number),
    );
    expect(rows).toHaveLength(4);
    FONTS.forEach((font, i) => expect(AFM_WIDTHS[font]).toEqual(rows[i]));
    const metrics = [...rust.slice(rust.indexOf("VMETRICS: ")).matchAll(/\((-?\d+), (-?\d+)\)/g)];
    FONTS.forEach((font, i) =>
      expect(AFM_VMETRICS[font]).toEqual({ ascender: Number(metrics[i][1]), descender: Number(metrics[i][2]) }),
    );
  });
});

describe("afm", () => {
  it("measures like text_width (integer AFM units)", () => {
    expect(textWidth("Courier", bytes("abcd"), 10)).toBe(24);
    expect(textWidth("Helvetica", bytes("Hello world"), 10)).toBeCloseTo(49.45, 10);
    expect(textWidth("Helvetica", [0, 10, 31], 10)).toBe(0);
    expect(ascent("Times-Roman")).toBe(683);
    expect(descent("Courier")).toBe(-157);
  });

  it("encodes Latin-1 and the cp1252 extras", () => {
    expect(Array.from(encodeWinAnsi("é€—"))).toEqual([0xe9, 0x80, 0x97]);
    expect(Array.from(encodeWinAnsi("“quoted” • …"))).toEqual([0x93, 113, 117, 111, 116, 101, 100, 0x94, 32, 0x95, 32, 0x85]);
    expect(Array.from(encodeWinAnsi(""))).toEqual([]);
  });

  it("rejects unsupported characters with the engine's message, deduplicated in order", () => {
    expect(() => encodeWinAnsi("日本 ok")).toThrow(new Error("Characters not supported by the standard PDF fonts: 日本"));
    expect(() => encodeWinAnsi("a日b本日")).toThrow(/: 日本$/);
    expect(() => encodeWinAnsi("tab\there")).toThrow();
    // Astral characters are one character, not two halves.
    expect(unsupportedChars("a😀b😀")).toBe("😀");
    expect(unsupportedChars("café")).toBe("");
  });
});

describe("wrapLines", () => {
  it("matches every shared vector (same file as the Rust test)", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(21);
    for (const v of vectors) {
      expect(wrapLines(v.text, v.font as StdFont, v.size, v.maxWidth), JSON.stringify(v)).toEqual(v.lines);
    }
  });

  it("keeps the spec examples", () => {
    const hello = textWidth("Helvetica", bytes("Hello world"), 10);
    expect(wrapLines("Hello world foo", "Helvetica", 10, hello)).toEqual(["Hello world", "foo"]);
    expect(wrapLines("\n\n", "Helvetica", 10, 100)).toEqual(["", "", ""]);
    expect(wrapLines("abcdefghij", "Courier", 10, 25)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("layoutText", () => {
  it("clips by height with the descender, like layout_text", () => {
    const lines = layoutText([100, 500, 200, 50], "a\nb\nc\nd\ne\nf", "Helvetica", 10, "left", 1.2);
    expect(lines.map((l) => Math.round(l.y * 1e6) / 1e6)).toEqual([542.82, 530.82, 518.82, 506.82]);
    expect(lines.map((l) => l.text)).toEqual(["a", "b", "c", "d"]);
    expect(lines.every((l) => l.x === 100)).toBe(true);
  });

  it("always keeps the first line", () => {
    expect(layoutText([0, 0, 200, 2], "a\nb", "Helvetica", 10, "left", 1.2)).toHaveLength(1);
  });

  it("skips empty lines but advances", () => {
    const lines = layoutText([0, 0, 200, 100], "a\n\nb", "Courier", 10, "left", 1);
    expect(lines).toHaveLength(2);
    expect(lines[0].y - lines[1].y).toBeCloseTo(20, 9);
  });

  it("aligns center and right", () => {
    expect(layoutText([50, 0, 100, 100], "ab\nabcd", "Courier", 10, "center", 1.2).map((l) => l.x)).toEqual([94, 88]);
    expect(layoutText([50, 0, 100, 100], "ab\nabcd", "Courier", 10, "right", 1.2).map((l) => l.x)).toEqual([138, 126]);
  });
});
