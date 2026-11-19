import { describe, expect, it } from "vitest";
import { FONT_BASE, fontCovers, fontUrl, parseManifest, type FontEntry } from "./manifest";

const entry: FontEntry = { file: "A_400Regular.ttf", family: "A", weight: 400, size: 10, ranges: [[0x20, 0x7e], [0x400, 0x4ff]] };

describe("parseManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(parseManifest({ version: 1, fonts: [entry] }).fonts[0]).toEqual(entry);
  });

  it.each([
    ["not an object", 3],
    ["wrong version", { version: 2, fonts: [] }],
    ["fonts not an array", { version: 1, fonts: {} }],
    ["a file that escapes the directory", { version: 1, fonts: [{ ...entry, file: "../x.ttf" }] }],
    ["a file with a path", { version: 1, fonts: [{ ...entry, file: "a/b.ttf" }] }],
    ["a bad weight", { version: 1, fonts: [{ ...entry, weight: 450 }] }],
    ["a negative size", { version: 1, fonts: [{ ...entry, size: -1 }] }],
    ["a reversed range", { version: 1, fonts: [{ ...entry, ranges: [[9, 3]] }] }],
    ["an unsorted range list", { version: 1, fonts: [{ ...entry, ranges: [[0x400, 0x4ff], [0x20, 0x7e]] }] }],
  ])("rejects %s", (_, raw) => {
    expect(() => parseManifest(raw)).toThrow();
  });
});

describe("fontCovers and fontUrl", () => {
  it("looks a code point up in the sorted ranges", () => {
    for (const cp of [0x20, 0x41, 0x7e, 0x400, 0x4ff]) expect(fontCovers(entry, cp), String(cp)).toBe(true);
    for (const cp of [0x1f, 0x7f, 0x3ff, 0x500, 0x10ffff]) expect(fontCovers(entry, cp), String(cp)).toBe(false);
  });

  it("builds same-origin URLs under /fonts-runtime", () => {
    expect(fontUrl(entry.file)).toBe(`${FONT_BASE}/A_400Regular.ttf`);
    expect(fontUrl("fonts.json")).toBe("/fonts-runtime/fonts.json");
  });
});
