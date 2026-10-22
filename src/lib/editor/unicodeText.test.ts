import { describe, expect, it } from "vitest";
import type { FontEntry, FontManifest } from "../fonts/manifest";
import { fitTextRect } from "./textFit";
import { isNoto, metricFont, missingMessage, planFonts, resolveFont, startsRightToLeft } from "./unicodeText";

const e = (family: string, ranges: [number, number][], weight: 400 | 700 = 400): FontEntry => ({
  file: `${family.replace(/ /g, "")}_${weight}.ttf`,
  family,
  weight,
  size: 1,
  ranges,
});
const LATIN: [number, number][] = [[0x20, 0x7e], [0xa0, 0x24f], [0x400, 0x4ff]];
const manifest: FontManifest = {
  version: 1,
  fonts: [
    e("Noto Sans", LATIN),
    e("Noto Sans", LATIN, 700),
    e("Noto Serif", LATIN),
    e("Noto Sans Mono", LATIN),
    e("Noto Sans Arabic", [[0x20, 0x20], [0x600, 0x6ff]]),
    e("Noto Sans Arabic", [[0x20, 0x20], [0x600, 0x6ff]], 700),
    e("Noto Sans Hebrew", [[0x5d0, 0x5ea]]),
    e("Noto Sans SC", [[0x4e00, 0x9fff], [0x3000, 0x303f]]),
    e("Noto Sans JP", [[0x3040, 0x30ff], [0x4e00, 0x9fff]]),
  ],
};
const files = (list: FontEntry[]) => list.map((f) => f.file);

describe("resolveFont", () => {
  it("keeps a standard font for WinAnsi text", () => {
    expect(resolveFont("Times-Roman", "café €")).toEqual({ kind: "standard", font: "Times-Roman" });
  });

  it("switches a standard font to its Noto family for other text", () => {
    expect(resolveFont("Helvetica", "Привет")).toEqual({ kind: "noto", family: "Noto Sans", bold: false, switched: true });
    expect(resolveFont("Helvetica-Bold", "你好")).toEqual({ kind: "noto", family: "Noto Sans", bold: true, switched: true });
    expect(resolveFont("Times-Roman", "Ελληνικά")).toMatchObject({ family: "Noto Serif", switched: true });
    expect(resolveFont("Courier", "שלום")).toMatchObject({ family: "Noto Sans Mono", switched: true });
  });

  it("uses a chosen Noto family for any text", () => {
    expect(resolveFont("Noto Serif", "plain")).toEqual({ kind: "noto", family: "Noto Serif", bold: false, switched: false });
    expect(isNoto("Noto Sans Mono")).toBe(true);
    expect(isNoto("Courier")).toBe(false);
    expect(metricFont("Noto Sans Mono")).toBe("Courier");
    expect(metricFont("Helvetica-Bold")).toBe("Helvetica-Bold");
  });
});

describe("planFonts", () => {
  it("passes the family first, then only the script fonts the text needs, in chain order", () => {
    const plan = planFonts(manifest, "你好 abc مرحبا", "Noto Sans", false, "SC");
    expect(files(plan.faces)).toEqual(["NotoSans_400.ttf", "NotoSansArabic_400.ttf", "NotoSansSC_400.ttf"]);
    expect(plan.fakeBold).toEqual([]);
    expect(plan.missing).toBe("");
  });

  it("always passes the family, even for text it does not cover", () => {
    expect(files(planFonts(manifest, "שלום", "Noto Serif", false, "SC").faces)).toEqual(["NotoSerif_400.ttf", "NotoSansHebrew_400.ttf"]);
  });

  it("strokes bold faces that have no Bold file (CJK)", () => {
    const plan = planFonts(manifest, "Hi 你好 مرحبا", "Noto Sans", true, "JP");
    expect(files(plan.faces)).toEqual(["NotoSans_700.ttf", "NotoSansArabic_700.ttf", "NotoSansJP_400.ttf"]);
    expect(files(plan.fakeBold)).toEqual(["NotoSansJP_400.ttf"]);
  });

  it("lists characters no font covers once, never whitespace", () => {
    expect(planFonts(manifest, "a😀 😀\u{1F600}ক", "Noto Sans", false, "SC").missing).toBe("😀ক");
    expect(missingMessage("😀")).toBe("No font can show these characters: 😀");
  });
});

describe("startsRightToLeft", () => {
  it.each([
    ["שלום abc", true],
    ["123 مرحبا", true],
    ["abc שלום", false],
    ["", false],
    ["  ...", false],
  ])("%s -> %s", (text, rtl) => {
    expect(startsRightToLeft(text)).toBe(rtl);
  });
});

describe("fitTextRect with Noto text", () => {
  it("grows the box for CJK lines the standard metrics would count as empty", () => {
    const rect: [number, number, number, number] = [0, 700, 50, 20];
    // 12 ideographs at 10 pt in a 50 pt box: at least 3 lines.
    const grown = fitTextRect(rect, "我们在测试中文换行没有空", "Helvetica", 10, 1.2);
    expect(grown[3]).toBeGreaterThanOrEqual(1.46 * 10 + 2 * 12);
    expect(grown[1] + grown[3]).toBeCloseTo(720);
    // WinAnsi text keeps the standard rule.
    expect(fitTextRect(rect, "ab", "Helvetica", 10, 1.2)).toEqual(rect);
  });
});
