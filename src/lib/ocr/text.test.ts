import { describe, expect, it } from "vitest";
import { HAS_TEXT_MIN_CHARS, exportText, hasText } from "./text";

describe("page text detection", () => {
  it("needs more than 20 non-blank characters", () => {
    const items = (...s: string[]) => s.map((str) => ({ str }));
    expect(HAS_TEXT_MIN_CHARS).toBe(20);
    expect(hasText(items("a".repeat(20)))).toBe(false);
    expect(hasText(items("a".repeat(21)))).toBe(true);
    expect(hasText(items("abcde fghij", "klmno", " pqrst  u"))).toBe(true);
    // Whitespace does not count.
    expect(hasText(items(" ".repeat(50), "\n\t", "abc"))).toBe(false);
    expect(hasText([])).toBe(false);
  });

  it("ignores pdf.js marked-content items without text", () => {
    expect(hasText([{ type: "beginMarkedContent" }, { str: "x".repeat(21) }])).toBe(true);
    expect(hasText([{ type: "beginMarkedContent" }])).toBe(false);
  });
});

describe("text export", () => {
  it("heads each page and separates pages with form feeds", () => {
    const out = exportText([
      { page: 1, text: "MANTIS OCR TEST 2026\nsecond line\n" },
      { page: 3, text: "" },
      { page: 4, text: "last" },
    ]);
    expect(out).toBe("--- Page 1 ---\nMANTIS OCR TEST 2026\nsecond line\n\f--- Page 3 ---\n\f--- Page 4 ---\nlast\n");
  });

  it("is empty for no pages", () => {
    expect(exportText([])).toBe("");
  });
});
