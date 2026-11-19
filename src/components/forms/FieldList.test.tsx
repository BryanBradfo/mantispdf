import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import FieldList from "./FieldList";
import { initialFormState, type FormField, type FormInfo, type FormValue, type FormWidget } from "../../lib/forms/model";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";

const widget: FormWidget = {
  page: 1,
  rect: [0, 0, 400, 20],
  rotation: 0,
  onState: null,
  hidden: false,
  font: "Helvetica",
  fontSize: 10,
  align: 0,
  annotIndex: 0,
  tabs: null,
};

function field(id: number, value: FormValue, extra: Partial<FormField> = {}): FormField {
  return {
    id,
    name: `f${id}`,
    label: `Field ${id}`,
    kind: { kind: "text", multiline: false, comb: false, maxLen: null, password: false },
    readOnly: false,
    required: false,
    value,
    options: [],
    onStates: [],
    widgets: [widget],
    ...extra,
  };
}

function render(fields: FormField[]) {
  const form: FormInfo = { xfa: "none", fields, signed: false };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <MemoryRouter>
      <FieldList fields={fields} state={initialFormState(form)} onChange={() => {}} page={1} onPage={() => {}} />
    </MemoryRouter>,
  );
  return host;
}

describe("FieldList invalid values", () => {
  it("marks an input whose value has characters no font has as aria-invalid, danger-bordered and described by its message", () => {
    const host = render([field(1, { kind: "text", text: "ok 😀" }), field(2, { kind: "text", text: "fine" })]);
    const [bad, good] = [...host.querySelectorAll<HTMLInputElement>("input")];
    expect(bad.getAttribute("aria-invalid")).toBe("true");
    expect(bad.className).toMatch(/!border-danger\b/);
    const message = [...host.querySelectorAll<HTMLElement>("[id]")].find((el) => el.id === bad.getAttribute("aria-describedby"))!;
    expect(message.getAttribute("role")).toBe("alert");
    expect(message.className).toMatch(/\btext-danger\b/);
    expect(good.hasAttribute("aria-invalid")).toBe(false);
    expect(good.className).not.toMatch(/danger/);
  });

  it("marks a value longer than the field allows as aria-invalid with a danger message", () => {
    const host = render([field(1, { kind: "text", text: "abcdef" }, { kind: { kind: "text", multiline: false, comb: false, maxLen: 3, password: false } })]);
    const input = host.querySelector<HTMLInputElement>("input")!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.className).toMatch(/!border-danger\b/);
    const message = [...host.querySelectorAll<HTMLElement>("[id]")].find((el) => el.id === input.getAttribute("aria-describedby"))!;
    expect(message.className).toMatch(/\btext-danger\b/);
  });

  it("uses theme tokens only", () => {
    const host = render([
      field(1, { kind: "text", text: "ok 😀" }, { required: true }),
      field(2, { kind: "none" }, { kind: { kind: "checkbox" }, onStates: ["Yes"] }),
      field(3, { kind: "none" }, { kind: { kind: "radio" }, onStates: ["A", "B"] }),
      field(4, { kind: "none" }, { kind: { kind: "signature" } }),
    ]);
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
  });
});
