// @vitest-environment node
/**
 * The real engine through its JS bindings (`list_form`, `fill_form` in the wasm package) on a tiny
 * form built here. Skipped when the package is not built (`npm run build:wasm`).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { initialFormState, setValue, type FormInfo } from "./model";
import { toWire } from "./toWire";
import { FIELD_KEYS, INFO_KEYS, KIND_KEYS, OPTION_KEYS, WIDGET_KEYS } from "./wireKeys";

const PKG = fileURLToPath(new URL("../../../crates/mantis-wasm/pkg/", import.meta.url));
const built = existsSync(`${PKG}mantis_wasm_bg.wasm`);

type Wasm = {
  list_form: (pdf: Uint8Array) => FormInfo;
  fill_form: (pdf: Uint8Array, values: unknown, flatten: boolean) => Uint8Array;
  initSync: (m: { module: BufferSource }) => unknown;
};
let wasm: Wasm;

beforeAll(async () => {
  if (!built) return;
  wasm = (await import(/* @vite-ignore */ `${PKG}mantis_wasm.js`)) as Wasm;
  wasm.initSync({ module: readFileSync(`${PKG}mantis_wasm_bg.wasm`) });
});

/** A PDF from object bodies (object n is `bodies[n - 1]`), with a correct xref table. */
function buildPdf(bodies: string[]): Uint8Array {
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** Text field, checkbox and radio group (two kids) without appearances, a list box. */
const FORM = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> /Annots [5 0 R 6 0 R 9 0 R 10 0 R 11 0 R] >>",
  "<< /Fields [5 0 R 6 0 R 7 0 R 11 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 8 0 R >> >> >>",
  "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /TU (Your name) /Rect [100 700 300 720] /P 3 0 R /DA (/Helv 12 Tf 0 g) >>",
  "<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /Rect [100 650 115 665] /P 3 0 R >>",
  "<< /FT /Btn /Ff 32768 /T (pick) /Kids [9 0 R 10 0 R] >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Type /Annot /Subtype /Widget /Parent 7 0 R /Rect [100 600 115 615] /P 3 0 R >>",
  "<< /Type /Annot /Subtype /Widget /Parent 7 0 R /Rect [200 600 215 615] /P 3 0 R >>",
  "<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 2097152 /T (fruit) /Opt [[(a) (Apple)] (b)] /Rect [100 500 200 560] /P 3 0 R >>",
]);

const keys = (o: object) => Object.keys(o).sort();

describe.skipIf(!built)("list_form / fill_form bindings", () => {
  it("lists every field with the documented keys", () => {
    const info = wasm.list_form(FORM);
    expect(keys(info)).toEqual([...INFO_KEYS].sort());
    expect(info.xfa).toBe("none");
    expect(info.fields.map((f) => [f.id, f.name, f.label, f.kind.kind])).toEqual([
      [0, "name", "Your name", "text"],
      [1, "agree", "agree", "checkbox"],
      [2, "pick", "pick", "radio"],
      [3, "fruit", "fruit", "list"],
    ]);
    for (const f of info.fields) {
      expect(keys(f)).toEqual([...FIELD_KEYS].sort());
      expect(keys(f.kind)).toEqual([...KIND_KEYS[f.kind.kind]].sort());
      for (const w of f.widgets) expect(keys(w)).toEqual([...WIDGET_KEYS].sort());
      for (const o of f.options) expect(keys(o)).toEqual([...OPTION_KEYS].sort());
    }
    expect(info.fields[0].kind).toEqual({ kind: "text", multiline: false, comb: false, maxLen: null, password: false });
    expect(info.fields[0].widgets).toEqual([{ page: 1, rect: [100, 700, 300, 720], rotation: 0, onState: null, hidden: false, font: "Helvetica", fontSize: 12, align: 0 }]);
    // Bare button widgets get engine-generated state names: one shared by the checkbox
    // widgets, one each for radio widgets.
    expect(info.fields[1].onStates).toEqual(["Yes"]);
    expect(info.fields[1].widgets.map((w) => w.onState)).toEqual(["Yes"]);
    expect(info.fields[2].onStates).toEqual(["On", "On2"]);
    expect(info.fields[2].widgets.map((w) => w.onState)).toEqual(["On", "On2"]);
    expect(info.fields[3].options).toEqual([{ exportValue: "a", display: "Apple" }, { exportValue: "b", display: "b" }]);
    expect(info.fields[3].kind).toEqual({ kind: "list", multi: true });
  });

  it("fills the changed values and reads them back", () => {
    const info = wasm.list_form(FORM);
    let s = initialFormState(info);
    // Buttons are set through the names the engine listed, never invented ones.
    const check = info.fields[1].widgets[0].onState;
    const secondRadio = info.fields[2].widgets[1].onState;
    if (check === null || secondRadio === null) throw new Error("engine listed no on state");
    s = setValue(s, 0, { kind: "text", text: "Ada Lovelace" });
    s = setValue(s, 1, { kind: "names", names: [check] });
    s = setValue(s, 2, { kind: "names", names: [secondRadio] });
    s = setValue(s, 3, { kind: "names", names: ["b", "a"] });
    const out = wasm.fill_form(FORM, toWire(s), false);
    const back = wasm.list_form(out);
    expect(back.fields.map((f) => f.value)).toEqual([
      { kind: "text", text: "Ada Lovelace" },
      { kind: "names", names: ["Yes"] },
      { kind: "names", names: ["On2"] },
      { kind: "names", names: ["a", "b"] },
    ]);
    // The checkbox now has its generated appearance under the same name.
    expect(back.fields[1].onStates).toEqual(["Yes"]);
    expect(back.fields[1].widgets[0].onState).toBe("Yes");
  });

  it("flattens: no fields are left", () => {
    const s = setValue(initialFormState(wasm.list_form(FORM)), 0, { kind: "text", text: "x" });
    const out = wasm.fill_form(FORM, toWire(s), true);
    expect(wasm.list_form(out).fields).toEqual([]);
  });

  it("refuses bad values with the engine's messages", () => {
    expect(() => wasm.fill_form(FORM, [{ id: 9, value: { kind: "none" } }], false)).toThrow("Invalid form settings: field");
    expect(() => wasm.fill_form(FORM, [{ id: 0, value: { kind: "bold" } }], false)).toThrow("Invalid form settings: values[0].value.kind");
    expect(() => wasm.fill_form(FORM, [{ id: 0.5, value: { kind: "none" } }], false)).toThrow("Invalid form settings: values[0].id");
    expect(() => wasm.fill_form(FORM, { id: 0 }, false)).toThrow("Invalid form settings: values");
    expect(() => wasm.fill_form(FORM, [{ id: 0, value: { kind: "text", text: "日本" } }], false)).toThrow(
      "Characters not supported by the standard PDF fonts: 日本",
    );
  });
});
