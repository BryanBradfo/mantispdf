import { describe, expect, it } from "vitest";
import {
  DEFAULT_STYLE,
  buildHeaderFooterJob,
  buildPageNumberJob,
  describePages,
  hexToRgb,
  todayIso,
  type HeaderFooterSlots,
} from "./stampBuilders";

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
    expect(describePages([1, 2, 3], 3)).toBe("All 3 pages");
    expect(describePages([3], 12)).toBe("Page 3 of 12");
    expect(describePages([2, 3], 12)).toBe("2 of 12 pages");
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
  const base = { style: DEFAULT_STYLE, margin: 20 };
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
});
