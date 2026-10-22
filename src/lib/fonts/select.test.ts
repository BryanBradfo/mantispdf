import { describe, expect, it } from "vitest";
import type { FontEntry, FontManifest } from "./manifest";
import { cjkFlavourFromLanguage, selectFonts } from "./select";

const e = (family: string, ranges: [number, number][], weight: 400 | 700 = 400): FontEntry => ({
  file: `${family.replace(/ /g, "")}_${weight}.ttf`, family, weight, size: 1, ranges,
});
const LATIN: [number, number][] = [[0x20, 0x7e], [0xa0, 0x24f], [0x400, 0x4ff]];
const manifest: FontManifest = {
  version: 1,
  fonts: [
    e("Noto Sans", LATIN), e("Noto Sans", LATIN, 700),
    e("Noto Serif", LATIN), e("Noto Sans Mono", LATIN),
    e("Noto Sans Arabic", [[0x20, 0x20], [0x600, 0x6ff]]), e("Noto Sans Arabic", [[0x20, 0x20], [0x600, 0x6ff]], 700),
    e("Noto Sans Hebrew", [[0x5d0, 0x5ea]]),
    e("Noto Sans Devanagari", [[0x900, 0x97f]]),
    e("Noto Sans Thai", [[0xe01, 0xe5b]]),
    e("Noto Sans SC", [[0x4e00, 0x9fff], [0x3000, 0x303f]]),
    e("Noto Sans TC", [[0x4e00, 0x9fff]]),
    e("Noto Sans JP", [[0x3040, 0x30ff], [0x4e00, 0x9fff]]),
    e("Noto Sans KR", [[0xac00, 0xd7a3], [0x4e00, 0x9fff]]),
  ],
};
const sel = (text: string, family = "Noto Sans", bold = false, cjk: "SC" | "TC" | "JP" | "KR" = "SC") =>
  selectFonts(manifest, text, { family, bold, cjk }).map((r) => [r.text, r.font?.family ?? null]);

describe("cjkFlavourFromLanguage", () => {
  it.each([
    ["zh-TW", "TC"], ["zh-HK", "TC"], ["zh-Hant", "TC"], ["zh-Hant-CN", "TC"], ["ja", "JP"], ["ja-JP", "JP"], ["ko-KR", "KR"],
    ["zh-CN", "SC"], ["zh", "SC"], ["zh-Hans", "SC"], ["en-US", "SC"], ["", "SC"], [undefined, "SC"],
  ])("%s -> %s", (lang, flavour) => {
    expect(cjkFlavourFromLanguage(lang)).toBe(flavour);
  });
});

describe("selectFonts", () => {
  it("returns no runs for empty text", () => {
    expect(selectFonts(manifest, "", { family: "Noto Sans", bold: false, cjk: "SC" })).toEqual([]);
  });

  it("keeps text the family covers in one run", () => {
    expect(sel("Héllo Привет")).toEqual([["Héllo Привет", "Noto Sans"]]);
  });

  it("falls back per character in the chain order", () => {
    expect(sel("a ب א क ก 中")).toEqual([
      ["a ", "Noto Sans"], ["ب", "Noto Sans Arabic"], [" ", "Noto Sans"], ["א", "Noto Sans Hebrew"], [" ", "Noto Sans"],
      ["क", "Noto Sans Devanagari"], [" ", "Noto Sans"], ["ก", "Noto Sans Thai"], [" ", "Noto Sans"], ["中", "Noto Sans SC"],
    ]);
  });

  it("uses the chosen CJK flavour, and a flavour that lacks the character is skipped", () => {
    expect(sel("中", "Noto Sans", false, "TC")).toEqual([["中", "Noto Sans TC"]]);
    expect(sel("中か", "Noto Sans", false, "JP")).toEqual([["中か", "Noto Sans JP"]]);
    // Kana is only in JP: SC is the flavour but JP still covers it, after the flavour.
    expect(sel("か", "Noto Sans", false, "SC")).toEqual([["か", "Noto Sans JP"]]);
    expect(sel("한", "Noto Sans", false, "SC")).toEqual([["한", "Noto Sans KR"]]);
  });

  it("flags characters no font covers", () => {
    expect(sel("a\u{1F600}b")).toEqual([["a", "Noto Sans"], ["\u{1F600}", null], ["b", "Noto Sans"]]);
  });

  it("uses the Serif and Mono families as the first link of the chain", () => {
    expect(sel("é中", "Noto Serif")).toEqual([["é", "Noto Serif"], ["中", "Noto Sans SC"]]);
    expect(sel("é", "Noto Sans Mono")).toEqual([["é", "Noto Sans Mono"]]);
  });

  it("picks Bold where it ships and Regular where it does not", () => {
    expect(selectFonts(manifest, "aب中", { family: "Noto Sans", bold: true, cjk: "SC" }).map((r) => [r.font?.family, r.font?.weight])).toEqual([
      ["Noto Sans", 700], ["Noto Sans Arabic", 700], ["Noto Sans SC", 400],
    ]);
  });

  it("walks code points, not UTF-16 units", () => {
    expect(sel("\u{20000}")).toEqual([["\u{20000}", null]]);
  });

  it("lets joiners and variation selectors follow the previous font", () => {
    expect(sel("ب‍ب")).toEqual([["ب‍ب", "Noto Sans Arabic"]]);
    expect(sel("中️")).toEqual([["中️", "Noto Sans SC"]]);
  });

  it("a leading joiner has no previous font and is flagged only if nothing covers it", () => {
    expect(sel("‍a")).toEqual([["‍", null], ["a", "Noto Sans"]]);
  });

  it("an unknown family yields only unflagged-by-family fallbacks, never a throw", () => {
    expect(sel("a", "Nope")).toEqual([["a", null]]);
  });
});
