import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import FieldControl from "./FieldControl";
import type { FormField, FormValue, FormWidget } from "../../lib/forms/model";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";
import { PAGE_MARK_DANGER, pageInvalid, pageMissing } from "../../styles/onPage";

const widget: FormWidget = {
  page: 1,
  rect: [0, 0, 200, 20],
  rotation: 0,
  onState: null,
  hidden: false,
  font: "Helvetica",
  fontSize: 10,
  align: 0,
  annotIndex: 0,
  tabs: null,
};

function field(extra: Partial<FormField> = {}): FormField {
  return {
    id: 1,
    name: "name",
    label: "Name",
    kind: { kind: "text", multiline: false, comb: false, maxLen: null, password: false },
    readOnly: false,
    required: false,
    value: { kind: "none" },
    options: [],
    onStates: [],
    widgets: [widget],
    ...extra,
  };
}
const text = (t: string): FormValue => ({ kind: "text", text: t });

function render(f: FormField, value: FormValue, w: FormWidget = widget) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <MemoryRouter>
      <FieldControl field={f} widget={w} index={0} value={value} onChange={() => {}} scale={1} box={{ left: 0, top: 0, width: 200, height: 20 }} />
    </MemoryRouter>,
  );
  return host;
}
const control = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-field-control]")!;

describe("FieldControl states read without colour alone", () => {
  it("a value with characters no font has is aria-invalid with the on-page red border and ring", () => {
    const host = render(field(), text("ok 😀"));
    const input = control(host);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.className).toContain(pageInvalid);
  });

  it("keeps a visible focus outline on an invalid field, apart from its red ring", () => {
    const input = control(render(field(), text("ok 😀")));
    expect(input.className).toContain(pageInvalid);
    for (const cls of ["focus:outline", "focus:outline-2", "focus:outline-offset-2", "focus:outline-black"]) {
      expect(input.className.split(/\s+/)).toContain(cls);
    }
    expect(input.className).not.toMatch(/focus:ring/);
  });

  it("keeps the focus outline on an invalid comb field's wrapper too", () => {
    const comb = field({ kind: { kind: "text", multiline: false, comb: true, maxLen: 4, password: false } });
    const wrapper = render(comb, text("ok 😀")).querySelector<HTMLElement>("div")!;
    expect(wrapper.className).toContain(pageInvalid);
    expect(wrapper.className).toMatch(/focus-within:outline-2\b/);
    expect(wrapper.className).toMatch(/focus-within:outline-black\b/);
  });

  it("a value longer than the field allows is aria-invalid with a danger border", () => {
    const host = render(field({ kind: { kind: "text", multiline: false, comb: false, maxLen: 3, password: false } }), text("abcdef"));
    const input = control(host);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.className).toContain(pageInvalid);
  });

  it("an empty required field is aria-required with a danger border", () => {
    const input = control(render(field({ required: true }), { kind: "none" }));
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(input.className).toContain(pageMissing);
  });

  it("a valid value has no invalid state and no danger", () => {
    const input = control(render(field(), text("Ada")));
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.className).not.toMatch(/\[#|danger/);
  });

  it("an empty required checkbox has a danger frame", () => {
    const box = render(field({ kind: { kind: "checkbox" }, required: true }), { kind: "none" }, { ...widget, onState: "Yes" });
    expect(box.querySelector<HTMLElement>("div")!.className).toContain(pageMissing);
  });

  it("uses no raw palette colour in any state", () => {
    for (const host of [
      render(field(), text("ok 😀")),
      render(field({ required: true }), { kind: "none" }),
      render(field({ kind: { kind: "signature" } }), { kind: "none" }),
      render(field({ readOnly: true }), text("x")),
    ]) {
      // The on-page red is the one fixed colour allowed (it comes from styles/onPage).
      expect(BANNED_COLOR_PATTERN.test(host.innerHTML.split(`[${PAGE_MARK_DANGER}]`).join(""))).toBe(false);
    }
  });
});
