import { describe, expect, it } from "vitest";
import {
  DEFAULT_STYLE,
  buildHeaderFooterJob,
  buildPageNumberJob,
  describePages,
  hexToRgb,
  pageNumberRange,
  previewHeaderFooter,
  previewStampText,
  todayIso,
  type HeaderFooterSlots,
} from "./stampBuilders";
import { tFor } from "../i18n/testUtils";

const tPages = tFor("pages");

const ctx = { total: 3, pages: [1, 2, 3], filename: "doc", date: "2026-10-17" };
const empty: HeaderFooterSlots = {
  "top-left": "", "top-center": "", "top-right": "", "bottom-left": "", "bottom-center": "", "bottom-right": "",
};

describe("helpers", () => {
  it("hexToRgb", () => {
    expect(hexToRgb("#ff0000")).toEqual([1, 0, 0]);
    expect(hexToRgb("nope")).toEqual([0, 0, 0]);
  });
  it("todayIso uses local date, zero padded", () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
  it("describePages", () => {
    expect(describePages([1, 2, 3], 3, tPages)).toBe("All 3 pages");
    expect(describePages([3], 12, tPages)).toBe("Page 3 of 12");
    expect(describePages([2, 3], 12, tPages)).toBe("2 of 12 pages");
  });
});

describe("buildPageNumberJob", () => {
  const settings = { anchor: "bottom-center" as const, template: "Page {n} of {total}", numberStart: 1, style: DEFAULT_STYLE, margin: 28 };
  it("all pages -> 'all', keeps Rust tokens", () => {
    const job = buildPageNumberJob(settings, ctx);
    expect(job.pages).toBe("all");
    expect(job.texts).toHaveLength(1);
    expect(job.texts[0]).toMatchObject({ template: "Page {n} of {total}", anchor: "bottom-center", marginX: 28, marginY: 28, size: 11 });
  });
  it("subset and numberStart; js tokens substituted", () => {
    const job = buildPageNumberJob({ ...settings, template: "{filename} {n}", numberStart: 5 }, { ...ctx, pages: [2, 3] });
    expect(job.pages).toEqual([2, 3]);
    expect(job.numberStart).toBe(5);
    expect(job.texts[0].template).toBe("doc {n}");
  });
});

describe("buildHeaderFooterJob", () => {
  const base = { style: DEFAULT_STYLE, margin: 20, numberStart: 1 };
  it("returns null when all blank", () => {
    expect(buildHeaderFooterJob({ ...base, slots: { ...empty, "top-left": "   " } }, ctx)).toBeNull();
  });
  it("emits one text per non-empty slot with anchors and date", () => {
    const job = buildHeaderFooterJob({ ...base, slots: { ...empty, "top-right": "{date}", "bottom-center": "{n}/{total}" } }, ctx);
    expect(job?.texts.map((t) => [t.anchor, t.template])).toEqual([
      ["top-right", "2026-10-17"],
      ["bottom-center", "{n}/{total}"],
    ]);
  });
  it("passes the first number through to the engine", () => {
    const job = buildHeaderFooterJob(
      { ...base, numberStart: 7, slots: { ...empty, "bottom-center": "{n}" } },
      { ...ctx, pages: [2, 3] },
    );
    expect(job?.numberStart).toBe(7);
    expect(job?.pages).toEqual([2, 3]);
  });
});

describe("previewHeaderFooter", () => {
  it("resolves the filled slots for the first selected page", () => {
    const slots = { ...empty, "top-left": "{filename} {date}", "bottom-center": "Page {n} of {total}", "bottom-right": "  " };
    expect(previewHeaderFooter(slots, 5, { ...ctx, total: 6, pages: [2, 3, 4] })).toEqual([
      { label: "Header left", text: "doc 2026-10-17" },
      { label: "Footer center", text: "Page 5 of 7" },
    ]);
  });
  it("is empty when nothing is filled", () => {
    expect(previewHeaderFooter(empty, 1, ctx)).toEqual([]);
  });
});

describe("pageNumberRange (matches the engine: n counts from the first selected page)", () => {
  it("all pages", () => {
    expect(pageNumberRange(1, [1, 2, 3, 4])).toEqual({ first: 1, last: 4 });
  });
  it("keeps document distance across gaps", () => {
    expect(pageNumberRange(1, [2, 5])).toEqual({ first: 1, last: 4 });
    expect(pageNumberRange(10, [3, 4, 12])).toEqual({ first: 10, last: 19 });
  });
  it("is order independent", () => {
    expect(pageNumberRange(1, [5, 2])).toEqual({ first: 1, last: 4 });
  });
  it("empty selection numbers from numberStart", () => {
    expect(pageNumberRange(3, [])).toEqual({ first: 3, last: 3 });
  });
});

describe("previewStampText", () => {
  const v = { n: 3, total: 12, date: "2026-10-17", filename: "doc" };
  it("resolves every token", () => {
    expect(previewStampText("Page {n} of {total}, {filename} {date}", v)).toBe("Page 3 of 12, doc 2026-10-17");
  });
  it("doubled braces are literal, unknown tokens kept", () => {
    expect(previewStampText("{{n}} {x} }}", v)).toBe("{n} {x} }");
  });
  it("a file name containing a token prints literally", () => {
    expect(previewStampText("{filename}", { ...v, filename: "report {n}" })).toBe("report {n}");
  });
});

describe("describePages in French", () => {
  it("describes the selection", () => {
    const t = tFor("pages", "fr");
    expect(describePages([1, 2, 3], 3, t)).toBe("Les 3\u00a0pages");
    expect(describePages([1], 1, t)).toBe("La seule page");
    expect(describePages([3], 12, t)).toBe("Page 3 sur 12");
    expect(describePages([2, 3], 12, t)).toBe("2 pages sur 12");
  });
});
