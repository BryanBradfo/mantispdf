import { describe, expect, it } from "vitest";
import { autoFontSize, overflows, widgetFrame, textFontSize } from "./layout";
import type { FieldKind, FormWidget } from "./model";

const widget = (rect: [number, number, number, number], extra: Partial<FormWidget> = {}): FormWidget => ({
  page: 1,
  rect,
  rotation: 0,
  onState: null,
  hidden: false,
  font: "Helvetica",
  fontSize: 12,
  align: 0,
  ...extra,
});

const text = (extra: Partial<Extract<FieldKind, { kind: "text" }>> = {}): FieldKind => ({
  kind: "text",
  multiline: false,
  comb: false,
  maxLen: null,
  password: false,
  ...extra,
});

describe("widgetFrame", () => {
  it("is the visible rect as [x, y, w, h], the content frame the same size", () => {
    expect(widgetFrame(widget([100, 700, 300, 720]))).toEqual({ rect: [100, 700, 200, 20], width: 200, height: 20 });
  });

  it("swaps the content frame sides for a quarter turn", () => {
    expect(widgetFrame(widget([100, 200, 120, 300], { rotation: 90 }))).toEqual({ rect: [100, 200, 20, 100], width: 100, height: 20 });
    expect(widgetFrame(widget([100, 200, 120, 300], { rotation: 270 })).width).toBe(100);
    expect(widgetFrame(widget([100, 200, 120, 300], { rotation: 180 })).width).toBe(20);
  });
});

describe("autoFontSize (the engine's rules, Helvetica metrics)", () => {
  it("single line: three quarters of the height", () => {
    expect(autoFontSize(text(), "", 200, 20)).toBe(15);
    expect(autoFontSize(text(), "Hi", 200, 20)).toBe(15);
  });

  it("single line: smaller when the text would not fit the width (2 pt padding each side)", () => {
    // "WWWWWWWWWW" is 10 x 944 units in Helvetica: 9.44 pt per point of size.
    expect(autoFontSize(text(), "WWWWWWWWWW", 98, 20)).toBeCloseTo(94 / 9.44, 6);
  });

  it("single line: not below 4 pt unless the height itself is smaller", () => {
    expect(autoFontSize(text(), "W".repeat(500), 50, 20)).toBe(4);
    expect(autoFontSize(text(), "W".repeat(500), 50, 4)).toBe(3);
  });

  it("multiline: the largest whole size from 12 down to 4 that fits", () => {
    // Engine test: 2 lines need 4 + 0.925 s + 1.15 s <= 20, so 7 pt.
    expect(autoFontSize(text({ multiline: true }), "one\ntwo", 200, 20)).toBe(7);
    expect(autoFontSize(text({ multiline: true }), "one", 200, 100)).toBe(12);
    expect(autoFontSize(text({ multiline: true }), "a\nb\nc\nd\ne\nf\ng\nh", 200, 20)).toBe(4);
  });

  it("comb: by height, or by the widest character in a cell (1 pt padding)", () => {
    expect(autoFontSize(text({ comb: true, maxLen: 5 }), "", 100, 20)).toBe(15);
    // cell 10 pt, "W" is 0.944 pt per point: (10 - 2) / 0.944.
    expect(autoFontSize(text({ comb: true, maxLen: 5 }), "aW", 50, 20)).toBeCloseTo(8 / 0.944, 6);
  });
});

describe("textFontSize", () => {
  it("uses the /DA size when there is one, the automatic size for 0", () => {
    const f = widget([0, 0, 200, 20], { fontSize: 9 });
    expect(textFontSize(text(), f, "anything")).toBe(9);
    expect(textFontSize(text(), { ...f, fontSize: 0 }, "")).toBe(15);
  });

  it("sizes in the rotated content frame", () => {
    const tall = widget([0, 0, 20, 200], { fontSize: 0, rotation: 90 });
    expect(textFontSize(text(), tall, "")).toBe(15);
  });

  it("measures with the widget's own font", () => {
    // Courier: every glyph 600 units, so 10 characters are 6 pt per point of size.
    const courier = widget([0, 0, 80, 20], { fontSize: 0, font: "Courier" });
    expect(textFontSize(text(), courier, "WWWWWWWWWW")).toBeCloseTo(76 / 6, 6);
    expect(autoFontSize(text(), "WWWWWWWWWW", 80, 20, "Courier")).toBeCloseTo(76 / 6, 6);
    // Helvetica's W is wider (944 units): a smaller size for the same box.
    expect(textFontSize(text(), { ...courier, font: "Helvetica" }, "WWWWWWWWWW")).toBeCloseTo(76 / 9.44, 6);
    // Times-Roman multiline: ascender 683, descender -217 (0.9 em) instead of Helvetica's 0.925.
    expect(autoFontSize(text({ multiline: true }), "one\ntwo", 200, 20, "Times-Roman")).toBe(7);
  });
});

describe("overflows (the engine clips what does not fit)", () => {
  it("single line with a fixed size: wider than the box minus 2 pt padding each side", () => {
    // "WWWWWWWWWW" at 10 pt is 94.4 pt wide.
    const w = (width: number) => widget([0, 0, width, 20], { fontSize: 10 });
    expect(overflows(text(), w(98.4), "WWWWWWWWWW")).toBe(false);
    expect(overflows(text(), w(98.3), "WWWWWWWWWW")).toBe(true);
    expect(overflows(text(), w(10), "")).toBe(false);
  });

  it("single line with auto size: only once the size is down to its 4 pt floor", () => {
    const auto = widget([0, 0, 50, 20], { fontSize: 0 });
    // Shrinks to fit: 46 / 0.944 per W = 48 W at 1 pt... 10 W fit at 4.87 pt.
    expect(overflows(text(), auto, "WWWWWWWWWW")).toBe(false);
    // 13 W need 4 * 0.944 * 13 = 49.1 pt > 46 pt even at 4 pt.
    expect(overflows(text(), auto, "WWWWWWWWWWWWW")).toBe(true);
  });

  it("multiline: more wrapped lines than the box height holds", () => {
    // 12 pt Helvetica, 2 lines: 4 + 0.925 * 12 + 1.15 * 12 = 28.9 pt.
    const box = (height: number) => widget([0, 0, 200, height], { fontSize: 12 });
    const ml = text({ multiline: true });
    expect(overflows(ml, box(29), "one\ntwo")).toBe(false);
    expect(overflows(ml, box(28.8), "one\ntwo")).toBe(true);
    // Auto size: overflows only below the 4 pt floor.
    const autoBox = widget([0, 0, 200, 20], { fontSize: 0 });
    expect(overflows(ml, autoBox, "a\nb")).toBe(false);
    expect(overflows(ml, autoBox, "a\nb\nc\nd\ne")).toBe(true);
  });

  it("uses the rotated content frame and the widget font", () => {
    const tall = widget([0, 0, 20, 98.4], { fontSize: 10, rotation: 90 });
    expect(overflows(text(), tall, "WWWWWWWWWW")).toBe(false);
    // Courier: 6 pt per character at 10 pt, so 10 characters need 60 + 4 pt.
    const courier = widget([0, 0, 63.9, 20], { fontSize: 10, font: "Courier" });
    expect(overflows(text(), courier, "WWWWWWWWWW")).toBe(true);
    expect(overflows(text(), { ...courier, rect: [0, 0, 64, 20] }, "WWWWWWWWWW")).toBe(false);
  });

  it("never for a comb field (one character per cell, the length is capped)", () => {
    const comb = text({ comb: true, maxLen: 3 });
    expect(overflows(comb, widget([0, 0, 10, 20], { fontSize: 30 }), "WWW")).toBe(false);
  });
});

