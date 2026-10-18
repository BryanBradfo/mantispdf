// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialFormState, setValue, type FormField, type FormInfo } from "./model";
import { toWire } from "./toWire";
import { ENTRY_KEYS, FIELD_KEYS, INFO_KEYS, KIND_KEYS, OPTION_KEYS, VALUE_KEYS, WIDGET_KEYS, XFA } from "./wireKeys";

/**
 * The wire contract with `crates/mantis-wasm/src/forms/binding.rs` (keys in `wireKeys.ts`).
 * Every key must appear as a string literal in the binding source, so a rename on either side
 * fails here.
 */
const binding = readFileSync(new URL("../../../crates/mantis-wasm/src/forms/binding.rs", import.meta.url), "utf8");
const literal = (s: string) => binding.includes(`"${s}"`);
const keys = (o: object) => Object.keys(o).sort();

const text: FormField["kind"] = { kind: "text", multiline: false, comb: false, maxLen: null, password: false };
const field = (id: number, value: FormField["value"]): FormField => ({
  id,
  name: `f${id}`,
  label: `f${id}`,
  kind: text,
  readOnly: false,
  required: false,
  value,
  options: [],
  onStates: [],
  widgets: [],
});

describe("fill-form wire shape", () => {
  it("sends only changed values, each with exactly the keys the binding reads", () => {
    const info: FormInfo = {
      xfa: "none",
      signed: false,
      fields: [field(0, { kind: "text", text: "a" }), field(1, { kind: "none" }), field(2, { kind: "names", names: ["On"] }), field(3, { kind: "none" })],
    };
    let s = initialFormState(info);
    s = setValue(s, 2, { kind: "none" });
    s = setValue(s, 0, { kind: "text", text: "b" });
    s = setValue(s, 1, { kind: "names", names: ["x", "x", "y"] });
    s = setValue(s, 3, { kind: "text", text: "" }); // same as none: not sent
    const wire = toWire(s);
    expect(wire.map((e) => e.id)).toEqual([0, 1, 2]);
    for (const e of wire) {
      expect(keys(e)).toEqual([...ENTRY_KEYS].sort());
      expect(keys(e.value)).toEqual([...VALUE_KEYS[e.value.kind]].sort());
    }
    expect(wire[1].value).toEqual({ kind: "names", names: ["x", "y"] });
    // The wire value is a copy, not the state's object.
    expect(wire[0].value).not.toBe(s.values.get(0));
  });

  it("the Rust binding reads and writes every key and kind as a literal", () => {
    const all = new Set<string>([
      ...ENTRY_KEYS,
      ...Object.keys(VALUE_KEYS),
      ...Object.values(VALUE_KEYS).flat(),
      ...INFO_KEYS,
      ...FIELD_KEYS,
      ...WIDGET_KEYS,
      ...OPTION_KEYS,
      ...Object.keys(KIND_KEYS),
      ...Object.values(KIND_KEYS).flat(),
      ...XFA,
    ]);
    expect([...all].filter((k) => !literal(k))).toEqual([]);
  });
});
