import { describe, expect, it } from "vitest";
import type { FormField, FormValue } from "./model";
import {
  FORM_LIMITS,
  choiceOptions,
  lengthLimit,
  lengthWarning,
  namesOf,
  selection,
  textOf,
  toggled,
  unsupportedIn,
} from "./values";

function field(extra: Partial<FormField> = {}): FormField {
  return {
    id: 0,
    name: "f",
    label: "f",
    kind: { kind: "text", multiline: false, comb: false, maxLen: null, password: false },
    readOnly: false,
    required: false,
    value: { kind: "none" },
    options: [],
    onStates: [],
    widgets: [],
    ...extra,
  };
}
const text = (t: string): FormValue => ({ kind: "text", text: t });
const names = (...n: string[]): FormValue => ({ kind: "names", names: n });

describe("value accessors", () => {
  it("read the text or the names of a value, empty otherwise", () => {
    expect(textOf(text("a"))).toBe("a");
    expect(textOf(names("a"))).toBe("");
    expect(textOf({ kind: "none" })).toBe("");
    expect(namesOf(names("a", "b"))).toEqual(["a", "b"]);
    expect(namesOf(text("a"))).toEqual([]);
  });
});

describe("toggled", () => {
  it("turns a checkbox state on, and off again", () => {
    expect(toggled({ kind: "none" }, "Yes")).toEqual(names("Yes"));
    expect(toggled(names("Yes"), "Yes")).toEqual({ kind: "none" });
    // Another state of the same field replaces the current one.
    expect(toggled(names("A"), "B")).toEqual(names("B"));
  });
});

describe("selection", () => {
  it("is the picked names, or no value when nothing is picked", () => {
    expect(selection(["a", "b"])).toEqual(names("a", "b"));
    expect(selection([])).toEqual({ kind: "none" });
  });
});

describe("unsupportedIn", () => {
  it("checks text and combo values only", () => {
    expect(unsupportedIn(field(), text("ok 日"))).toBe("日");
    expect(unsupportedIn(field({ kind: { kind: "combo", editable: true } }), text("€ ✓"))).toBe("✓");
    expect(unsupportedIn(field({ kind: { kind: "list", multi: true } }), names("日"))).toBe("");
    expect(unsupportedIn(field(), text("line\nbreak\ttab"))).toBe("");
  });
});

describe("length limits", () => {
  it("is the field's max length, else the engine's value limit", () => {
    expect(FORM_LIMITS.valueChars).toBe(20000);
    expect(lengthLimit(field())).toBe(20000);
    expect(lengthLimit(field({ kind: { kind: "text", multiline: false, comb: true, maxLen: 6, password: false } }))).toBe(6);
    expect(lengthLimit(field({ kind: { kind: "combo", editable: true } }))).toBe(20000);
  });

  it("warns about a value longer than the field allows, without changing it", () => {
    const short = field({ kind: { kind: "text", multiline: false, comb: false, maxLen: 3, password: false } });
    expect(lengthWarning(short, text("abc"))).toBeNull();
    expect(lengthWarning(short, text("abcd"))).toBe("This value is longer than the field allows (3 characters).");
    expect(lengthWarning(field(), text("x".repeat(20001)))).toMatch(/20000 characters/);
    // Characters, not UTF-16 units.
    expect(lengthWarning(short, text("€€€"))).toBeNull();
  });
});

describe("choiceOptions", () => {
  const combo = field({
    kind: { kind: "combo", editable: false },
    options: [
      { exportValue: "fr", display: "France" },
      { exportValue: "de", display: "Germany" },
    ],
  });

  it("is the field's options when the value is one of them (or empty)", () => {
    expect(choiceOptions(combo, text("de"))).toEqual(combo.options);
    expect(choiceOptions(combo, { kind: "none" })).toEqual(combo.options);
  });

  it("adds the current value when the options lack it, so a select can show it", () => {
    expect(choiceOptions(combo, text("it"))).toEqual([...combo.options, { exportValue: "it", display: "it" }]);
  });

  it("adds missing names of a list box once each", () => {
    const list = { ...combo, kind: { kind: "list" as const, multi: true } };
    expect(choiceOptions(list, names("fr", "xx", "xx"))).toEqual([...combo.options, { exportValue: "xx", display: "xx" }]);
  });
});
