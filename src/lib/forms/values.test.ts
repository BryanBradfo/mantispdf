import { describe, expect, it } from "vitest";
import type { FormField, FormValue } from "./model";
import { FORM_LIMITS, blockingProblem as blockingProblemT, choiceOptions, comboValueFor, isEmpty, missingRequired, radioLabel as radioLabelT, shownText, lengthLimit, lengthWarning as lengthWarningT, namesOf, selection, textOf, toggled, unsupportedIn } from "./values";
import { tFor } from "../../i18n/testUtils";

const tEn = tFor("fillForm");
const lengthWarning = (f: Parameters<typeof lengthWarningT>[0], v: Parameters<typeof lengthWarningT>[1]) => lengthWarningT(f, v, tEn);
const radioLabel = (f: Parameters<typeof radioLabelT>[0], s: string) => radioLabelT(f, s, tEn);
const blockingProblem = (f: Parameters<typeof blockingProblemT>[0], s: Parameters<typeof blockingProblemT>[1]) => blockingProblemT(f, s, tEn);

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

describe("isEmpty", () => {
  it("treats no value, empty text and an empty selection alike", () => {
    expect(isEmpty({ kind: "none" })).toBe(true);
    expect(isEmpty(text(""))).toBe(true);
    expect(isEmpty(names())).toBe(true);
    expect(isEmpty(text(" "))).toBe(false);
    expect(isEmpty(names("a"))).toBe(false);
  });
});

describe("editable combo text", () => {
  const combo = field({
    kind: { kind: "combo", editable: true },
    options: [
      { exportValue: "fr", display: "France" },
      { exportValue: "de", display: "Germany" },
    ],
  });

  it("shows the display text of the chosen option, else the typed text", () => {
    expect(shownText(combo, text("de"))).toBe("Germany");
    expect(shownText(combo, text("Narnia"))).toBe("Narnia");
    expect(shownText(field(), text("de"))).toBe("de");
  });

  it("stores the export value when the typed text is an option's display text", () => {
    expect(comboValueFor(combo, "Germany")).toEqual(text("de"));
    expect(comboValueFor(combo, "Narnia")).toEqual(text("Narnia"));
    expect(comboValueFor(combo, "")).toEqual({ kind: "none" });
  });
});

describe("radioLabel", () => {
  const radio = (onStates: string[], options: FormField["options"] = []) =>
    field({ kind: { kind: "radio" }, onStates, options });

  it("uses the /Opt display of the state when there is one", () => {
    const r = radio(["0", "1"], [
      { exportValue: "Yes", display: "Yes, please" },
      { exportValue: "No", display: "No thanks" },
    ]);
    expect(radioLabel(r, "1")).toBe("No thanks");
    expect(radioLabel(radio(["a"], [{ exportValue: "a", display: "Apple" }]), "a")).toBe("Apple");
  });

  it("numbers engine-generated and index names, keeps meaningful ones", () => {
    const gen = radio(["On", "On2", "On3"]);
    expect(radioLabel(gen, "On")).toBe("Option 1");
    expect(radioLabel(gen, "On2")).toBe("Option 2");
    expect(radioLabel(radio(["0", "1"]), "1")).toBe("Option 2");
    expect(radioLabel(radio(["red", "green"]), "green")).toBe("green");
  });
});

describe("download checks", () => {
  const state = (entries: [number, FormValue][]) => {
    const values = new Map(entries);
    return { original: values, values };
  };
  const named = (id: number, label: string, extra: Partial<FormField> = {}) => field({ id, label, name: label, ...extra });

  it("lists the required fields left empty, in the given order (fillable ones only)", () => {
    const fields = [
      named(0, "A", { required: true }),
      named(1, "B", { required: true }),
      named(2, "C"),
      named(3, "D", { required: true, readOnly: true }),
      named(4, "E", { required: true, kind: { kind: "signature" } }),
    ];
    const s = state([[0, text("")], [1, text("x")], [2, text("")], [3, text("")], [4, { kind: "none" }]]);
    expect(missingRequired(fields, s).map((f) => f.label)).toEqual(["A"]);
  });

  /** The file's values, then the edits on top. */
  const edited = (original: [number, FormValue][], changes: [number, FormValue][]) => {
    const base = new Map(original);
    return { original: base, values: new Map([...base, ...changes]) };
  };
  const fields = [
    named(0, "Name"),
    named(1, "Code", { kind: { kind: "text", multiline: false, comb: false, maxLen: 2, password: false } }),
  ];
  const file: [number, FormValue][] = [
    [0, text("")],
    [1, text("")],
  ];

  it("names the first changed field the engine would refuse", () => {
    expect(blockingProblem(fields, edited(file, [[0, text("ok")], [1, text("ok")]]))).toBeNull();
    expect(blockingProblem(fields, edited(file, [[0, text("日")], [1, text("long")]]))).toBe(
      'Characters not supported by the standard PDF fonts: 日 (field "Name").',
    );
    expect(blockingProblem(fields, edited(file, [[0, text("ok")], [1, text("long")]]))).toBe(
      'This value is longer than the field allows (2 characters). (field "Code")',
    );
  });

  it("ignores values left as the file has them (the engine keeps them as they are)", () => {
    const fromFile: [number, FormValue][] = [
      [0, text("日本語")],
      [1, text("too long")],
    ];
    expect(blockingProblem(fields, edited(fromFile, []))).toBeNull();
    // Editing one of them makes it count again.
    expect(blockingProblem(fields, edited(fromFile, [[1, text("still long")]]))).toBe(
      'This value is longer than the field allows (2 characters). (field "Code")',
    );
  });
});

describe("form messages in French", () => {
  it("reads in French", () => {
    const t = tFor("fillForm", "fr");
    expect(lengthWarningT(field({ kind: { kind: "text", multiline: false, password: false, comb: false, maxLen: 3 } }), text("abcd"), t)).toBe(
      "Cette valeur dépasse la longueur autorisée par le champ (3\u00a0caractères).",
    );
  });
});
