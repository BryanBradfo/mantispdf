import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import CropPageStrip from "./CropPageStrip";

class Idle {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("IntersectionObserver", Idle);
});
afterAll(() => vi.unstubAllGlobals());

describe("CropPageStrip", () => {
  it("marks the shown page with aria-pressed, a 2 px ink outline that focus cannot remove, and a check", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<CropPageStrip source={new Blob()} count={3} page={2} disabled={false} onPage={() => {}} />));
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    const frame = buttons[1].querySelector<HTMLElement>("[data-selected-frame]")!;
    expect(frame.className).toMatch(/\boutline-2\b/);
    expect(frame.className).toMatch(/\boutline-ink\b/);
    // The frame is not the focused element, so the focus ring's outline-none never reaches it.
    expect(frame.className).not.toContain("focus-visible:");
    expect(buttons[1].querySelector("svg.lucide-check")).not.toBeNull();
    expect(buttons[0].querySelector("[data-selected-frame]")).toBeNull();
    expect(buttons[0].querySelector("svg.lucide-check")).toBeNull();
    act(() => root.unmount());
  });
});
