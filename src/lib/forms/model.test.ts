import { describe, expect, it } from "vitest";
import { dirtyIds, initialFormState, isDirty, isDrawn, isEditable, resetForm, sameValue, setValue, valueOf, type FormField, type FormInfo, type FormValue } from "./model";

function field(id: number, value: FormValue, extra: Partial<FormField> = {}): FormField {
  return {
    id,
    name: `f${id}`,
    label: `f${id}`,
    kind: { kind: "text", multiline: false, comb: false, maxLen: null, password: false },
    readOnly: false,
    required: false,
    value,
    options: [],
    onStates: [],
    widgets: [],
    ...extra,
  };
}

const info: FormInfo = {
  xfa: "none",
  fields: [field(0, { kind: "text", text: "Ada" }), field(1, { kind: "none" }), field(2, { kind: "names", names: ["a", "b"] })],
};

describe("form state", () => {
  it("starts clean and tracks changed values", () => {
    let s = initialFormState(info);
    expect(dirtyIds(s)).toEqual([]);
    s = setValue(s, 1, { kind: "text", text: "x" });
    s = setValue(s, 0, { kind: "text", text: "Bob" });
    expect(dirtyIds(s)).toEqual([0, 1]);
    expect(valueOf(s, 1)).toEqual({ kind: "text", text: "x" });
    s = setValue(s, 0, { kind: "text", text: "Ada" });
    expect(isDirty(s, 0)).toBe(false);
    expect(dirtyIds(s)).toEqual([1]);
  });

  it("ignores unknown ids and resets to the file's values", () => {
    let s = initialFormState(info);
    expect(setValue(s, 99, { kind: "none" })).toBe(s);
    s = setValue(s, 2, { kind: "names", names: [] });
    expect(dirtyIds(s)).toEqual([2]);
    s = resetForm(s);
    expect(dirtyIds(s)).toEqual([]);
    expect(valueOf(s, 2)).toEqual({ kind: "names", names: ["a", "b"] });
  });

  it("compares values like the engine: empty is none, selections are sets", () => {
    expect(sameValue({ kind: "text", text: "" }, { kind: "none" })).toBe(true);
    expect(sameValue({ kind: "names", names: [] }, { kind: "none" })).toBe(true);
    expect(sameValue({ kind: "names", names: ["b", "a", "a"] }, { kind: "names", names: ["a", "b"] })).toBe(true);
    expect(sameValue({ kind: "names", names: ["a"] }, { kind: "text", text: "a" })).toBe(false);
    expect(sameValue({ kind: "text", text: "a" }, { kind: "text", text: "A" })).toBe(false);
  });

  it("knows which widgets are drawn and which fields are editable", () => {
    const w = { page: 1, rect: [0, 0, 1, 1] as [number, number, number, number], rotation: 0 as const, onState: null, hidden: false, font: "Helvetica" as const, fontSize: 0, align: 0 as const };
    expect(isDrawn(w)).toBe(true);
    expect(isDrawn({ ...w, page: 0 })).toBe(false);
    expect(isDrawn({ ...w, hidden: true })).toBe(false);
    expect(isEditable(field(0, { kind: "none" }))).toBe(true);
    expect(isEditable(field(0, { kind: "none" }, { readOnly: true }))).toBe(false);
    expect(isEditable(field(0, { kind: "none" }, { kind: { kind: "signature" } }))).toBe(false);
    expect(isEditable(field(0, { kind: "none" }, { kind: { kind: "button" } }))).toBe(false);
  });
});
