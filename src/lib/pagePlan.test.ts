import { describe, it, expect } from "vitest";
import { encodePlan, formatPageRanges, parsePageRanges } from "./pagePlan";

describe("encodePlan", () => {
  it("encodes pages and blanks as triples", () => {
    expect(Array.from(encodePlan([
      { kind: "page", src: 0, page: 2, rotate: 90 },
      { kind: "blank" },
      { kind: "page", src: 1, page: 1, rotate: -90 },
    ]))).toEqual([0, 2, 90, -1, 0, 0, 1, 1, -90]);
  });
});

describe("parsePageRanges", () => {
  const ok = (text: string, total = 10) => {
    const r = parsePageRanges(text, total);
    if (!r.ok) throw new Error(r.error);
    return r.pages;
  };
  const err = (text: string, total = 10) => {
    const r = parsePageRanges(text, total);
    if (r.ok) throw new Error("expected an error");
    return r.error;
  };

  it("parses singles, ranges and open ranges", () => {
    expect(ok("1-3, 7, 9-")).toEqual([1, 2, 3, 7, 9, 10]);
    expect(ok("-2")).toEqual([1, 2]);
  });
  it("ignores whitespace, empty tokens and duplicates; sorts", () => {
    expect(ok(" 3 - 4 ,, 1, 3 ")).toEqual([1, 3, 4]);
    expect(ok("")).toEqual([]);
    expect(ok("   ")).toEqual([]);
  });
  it("reports unreadable tokens", () => {
    expect(err("1, abc")).toContain('"abc"');
    expect(err("-")).toContain('"-"');
    expect(err("1-2-3")).toContain('"1-2-3"');
  });
  it("reports out-of-range and backwards ranges", () => {
    expect(err("0")).toContain("start at 1");
    expect(err("11")).toContain("11");
    expect(err("11-")).toContain("11");
    expect(err("5-12")).toContain("12");
    expect(err("5-3")).toContain("backwards");
  });
});

describe("formatPageRanges", () => {
  it("compresses runs", () => {
    expect(formatPageRanges([7, 1, 2, 3, 10, 11])).toBe("1-3, 7, 10-11");
    expect(formatPageRanges([])).toBe("");
    expect(formatPageRanges([4, 4])).toBe("4");
  });
  it("round-trips with parse", () => {
    const pages = [1, 2, 5, 6, 7, 9];
    const r = parsePageRanges(formatPageRanges(pages), 9);
    expect(r).toEqual({ ok: true, pages });
  });
});
