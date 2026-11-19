import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import RedactCanvas from "./RedactCanvas";
import type { Mark } from "../../lib/redact/model";
import { PAGE_MARK_DARK, PAGE_MARK_LIGHT, REDACT_PREVIEW } from "../../styles/onPage";
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

const marks: Mark[] = [
  { id: "a", kind: "area", page: 1, rect: [100, 100, 200, 50] },
  { id: "b", kind: "search", page: 1, rect: [100, 400, 80, 12], query: "SMITH" },
];

function render(props: Partial<Parameters<typeof RedactCanvas>[0]> = {}) {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() =>
    root.render(
      <RedactCanvas
        source={new Blob()}
        page={1}
        pageSize={[612, 792]}
        marks={marks}
        fill="black"
        locked={false}
        selectedId="a"
        flash={[[100, 400, 80, 12]]}
        onSelect={() => {}}
        onAdd={() => {}}
        onUpdate={() => {}}
        onDelete={() => {}}
        {...props}
      />,
    ),
  );
  return { host, unmount: () => act(() => root.unmount()) };
}

/** Every literal colour painted in the overlay (pattern references and transparent hit areas aside). */
function paints(host: HTMLElement): string[] {
  const values = [...host.querySelectorAll("svg *")].flatMap((el) => [el.getAttribute("fill"), el.getAttribute("stroke")]);
  return values.filter((v): v is string => v !== null && !v.startsWith("url(") && v !== "transparent" && v !== "none");
}

describe("RedactCanvas", () => {
  it("frames the selected mark with a white-under-black dashed outline and black square handles", () => {
    const { host, unmount } = render();
    const frames = host.querySelectorAll("[data-selected-frame]");
    expect(frames).toHaveLength(1);
    const strokes = [...frames[0].querySelectorAll("rect")].map((r) => r.getAttribute("stroke"));
    expect(strokes).toEqual([PAGE_MARK_LIGHT, PAGE_MARK_DARK]);
    const handles = host.querySelectorAll("[data-handle]");
    expect(handles).toHaveLength(8);
    const knob = handles[0].querySelectorAll("rect")[1];
    expect(knob.getAttribute("fill")).toBe(PAGE_MARK_DARK);
    expect(knob.getAttribute("stroke")).toBe(PAGE_MARK_LIGHT);
    expect(knob.hasAttribute("rx")).toBe(false);
    unmount();
  });

  it("shows a search match with a still black and white frame, not a yellow pulse", () => {
    const { host, unmount } = render({ selectedId: null });
    const flash = host.querySelector("[data-flash]")!;
    expect(flash).not.toBeNull();
    expect(flash.outerHTML).not.toMatch(/animate-/);
    expect([...flash.querySelectorAll("rect")].map((r) => r.getAttribute("stroke"))).toEqual([PAGE_MARK_LIGHT, PAGE_MARK_DARK]);
    expect(host.querySelector("[data-selected-frame]")).toBeNull();
    unmount();
  });

  it("paints only the on-page black and white marks and the redaction preview colours", () => {
    const allowed = new Set<string>([PAGE_MARK_DARK, PAGE_MARK_LIGHT, ...Object.values(REDACT_PREVIEW).flatMap((p) => Object.values(p))]);
    for (const fill of ["black", "white"] as const) {
      const { host, unmount } = render({ fill });
      for (const paint of paints(host)) expect(allowed).toContain(paint);
      const root = host.querySelector<HTMLElement>('[data-testid="redact-canvas"]')!;
      expect(root.className).toMatch(/\bborder-line\b/);
      expect(root.className).toContain("focus-visible:ring-2");
      expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
      unmount();
    }
  });

  it("reports a page with no visible area in the danger colour", () => {
    const { host, unmount } = render({ pageSize: [0, 0] });
    expect(host.querySelector('[role="alert"]')!.className).toMatch(/\btext-danger\b/);
    unmount();
  });
});
