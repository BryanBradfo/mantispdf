import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import SignaturePad from "./SignaturePad";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

const classes = (el: Element) => el.className.split(/\s+/);

describe("SignaturePad typed styles", () => {
  it("draws keyboard focus apart from the picked outline: an inset black ring inside the white sample", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<SignaturePad onChange={() => {}} />));
    const typeTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Type")!;
    act(() => typeTab.click());
    const samples = [...host.querySelectorAll<HTMLLabelElement>("fieldset label")];
    expect(samples).toHaveLength(3);
    const [picked, other] = samples;
    expect(picked.querySelector("input")!.checked).toBe(true);
    // Picked: a 2 px outline outside the sample (offset 2) and a check.
    expect(classes(picked)).toEqual(expect.arrayContaining(["outline", "outline-2", "outline-offset-2"]));
    expect(picked.querySelector("svg.lucide-check")).not.toBeNull();
    expect(other.querySelector("svg.lucide-check")).toBeNull();
    // Focus: inside the sample, so it never shares the outline's band; black, the sample is white in both themes.
    for (const s of samples) {
      expect(classes(s)).toEqual(expect.arrayContaining(["has-[:focus-visible]:ring-2", "has-[:focus-visible]:ring-inset", "has-[:focus-visible]:ring-black"]));
      expect(s.className).not.toMatch(/has-\[:focus-visible\]:ring-offset/);
    }
    act(() => root.unmount());
  });
});
