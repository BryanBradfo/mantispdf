import { describe, expect, it } from "vitest";
import type { FontEntry, FontManifest } from "../fonts/manifest";
import { initialFormState, setValue, type FormField, type FormInfo, type FormValue, type FormWidget } from "./model";
import { fieldPlan, formFonts, notoFamily, notoNotice, overflowRequest, overflowsLayout, uncoveredIn } from "./unicode";
import { blockingProblem } from "./values";
import { missingMessage } from "../editor/unicodeText";

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
    e("Noto Sans SC", [[0x4e00, 0x9fff]]),
  ],
};

function widget(extra: Partial<FormWidget> = {}): FormWidget {
  return { page: 1, rect: [100, 700, 300, 720], rotation: 0, onState: null, hidden: false, font: "Helvetica", fontSize: 12, align: 0, annotIndex: 0, tabs: null, ...extra };
}
function field(id: number, extra: Partial<FormField> = {}): FormField {
  return {
    id,
    name: `f${id}`,
    label: `f${id}`,
    kind: { kind: "text", multiline: false, comb: false, maxLen: null, password: false },
    readOnly: false,
    required: false,
    value: { kind: "none" },
    options: [],
    onStates: [],
    widgets: [widget()],
    ...extra,
  };
}
const text = (t: string): FormValue => ({ kind: "text", text: t });

describe("Noto values in forms", () => {
  it("use the Noto family of the field's /DA font, only for text the standard fonts lack", () => {
    expect(notoFamily(field(0), text("café"))).toBeNull();
    expect(notoFamily(field(0), text("Привет"))).toEqual({ family: "Noto Sans", bold: false });
    expect(notoFamily(field(0, { widgets: [widget({ font: "Times-Roman" })] }), text("Привет"))).toEqual({ family: "Noto Serif", bold: false });
    expect(notoFamily(field(0, { widgets: [widget({ font: "Helvetica-Bold" })] }), text("你好"))).toEqual({ family: "Noto Sans", bold: true });
    expect(notoFamily(field(0, { kind: { kind: "checkbox" } }), { kind: "names", names: ["日"] })).toBeNull();
    expect(notoNotice(field(0, { widgets: [widget({ font: "Courier" })] }), text("Привет"))).toBe("Uses Noto Sans Mono for these characters");
  });

  it("flag only characters no font covers, once the font list is known", () => {
    expect(uncoveredIn(field(0), text("你好 😀"), manifest, "SC")).toBe("😀");
    expect(uncoveredIn(field(0), text("😀"), null, "SC")).toBe("");
    expect(uncoveredIn(field(0), text("plain"), manifest, "SC")).toBe("");
  });

  it("send the fonts of every field whose value needs them, each file once", () => {
    const info: FormInfo = {
      xfa: "none",
      signed: false,
      fields: [field(0), field(1, { widgets: [widget({ font: "Helvetica-Bold" })] }), field(2, { value: text("你好") })],
    };
    let state = initialFormState(info);
    state = setValue(state, 0, text("Привет"));
    state = setValue(state, 1, text("你好"));
    expect(formFonts(info.fields, state, manifest, "SC")).toEqual({
      files: ["NotoSans_400.ttf", "NotoSans_700.ttf", "NotoSansSC_400.ttf"],
      fields: [
        { field: 0, faces: ["NotoSans_400.ttf"], fakeBold: [] },
        { field: 1, faces: ["NotoSans_700.ttf", "NotoSansSC_400.ttf"], fakeBold: ["NotoSansSC_400.ttf"] },
        // A kept value (flattening redraws it).
        { field: 2, faces: ["NotoSans_400.ttf", "NotoSansSC_400.ttf"], fakeBold: [] },
      ],
    });
    expect(formFonts([field(0)], initialFormState({ ...info, fields: [field(0)] }), manifest, "SC")).toBeUndefined();
  });

  it("block a download only for characters no font covers", () => {
    const info: FormInfo = { xfa: "none", signed: false, fields: [field(0)] };
    const state = setValue(initialFormState(info), 0, text("你好 😀"));
    const uncovered = (f: FormField, v: FormValue) => uncoveredIn(f, v, manifest, "SC");
    expect(blockingProblem(info.fields, state, uncovered, missingMessage)).toBe('No font can show these characters: 😀 (field "f0").');
    expect(blockingProblem(info.fields, setValue(state, 0, text("你好")), uncovered, missingMessage)).toBeNull();
  });

  it("judge overflow from the engine's lines", () => {
    const f = field(0);
    const plan = fieldPlan(f, text("你好"), manifest, "SC")!;
    const request = overflowRequest(f, f.widgets[0], "你好", plan);
    expect(request).toMatchObject({ fonts: ["NotoSans_400.ttf", "NotoSansSC_400.ttf"], size: 12, align: "left" });
    const line = (width: number) => ({ lines: [{ baselineY: 12, runs: [{ face: 0, rtl: false, x: 0, width, text: "x" }] }], missing: "" });
    // The box is 200 pt wide, 196 inside the padding.
    expect(overflowsLayout(f, f.widgets[0], 12, line(190))).toBe(false);
    expect(overflowsLayout(f, f.widgets[0], 12, line(200))).toBe(true);
    // Multiline: lines past the 20 pt height.
    const multi = field(0, { kind: { kind: "text", multiline: true, comb: false, maxLen: null, password: false } });
    const lines = (n: number) => ({ lines: Array.from({ length: n }, (_, i) => ({ baselineY: 12 + i * 13.8, runs: [] })), missing: "" });
    expect(overflowsLayout(multi, multi.widgets[0], 12, lines(1))).toBe(false);
    expect(overflowsLayout(multi, multi.widgets[0], 12, lines(2))).toBe(true);
  });
});
