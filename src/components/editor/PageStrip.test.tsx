import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PageStrip from "./PageStrip";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";

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

describe("editor PageStrip", () => {
  it("marks the shown page with aria-pressed, an ink outline focus cannot remove and a check; edited pages with an ink dot", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<PageStrip source={new Blob()} pageCount={3} page={2} edited={new Set([3])} onPage={() => {}} />));
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    const frame = buttons[1].querySelector<HTMLElement>("[data-selected-frame]")!;
    expect(frame.className).toMatch(/\boutline-2\b/);
    expect(frame.className).toMatch(/\boutline-ink\b/);
    expect(frame.className).not.toContain("focus-visible:");
    expect(buttons[1].querySelector("svg.lucide-check")).not.toBeNull();
    expect(buttons[0].querySelector("[data-selected-frame]")).toBeNull();
    expect(buttons[2].getAttribute("aria-label")).toBe("Page 3, edited");
    // On the page thumbnail (white in both themes): fixed black, not the theme ink.
    expect(buttons[2].querySelector("[data-edited-mark]")!.className).toMatch(/\bbg-black\b/);
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
    act(() => root.unmount());
  });
});
