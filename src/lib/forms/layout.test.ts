import { describe, expect, it } from "vitest";
import { autoFontSize, widgetFrame, textFontSize } from "./layout";
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
});
