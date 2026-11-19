import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import DecodeText from "./DecodeText";

let root: Root;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(ui: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(ui));
  return host;
}

const reducedMotion = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches, media: q, addEventListener() {}, removeEventListener() {} }));

/** The running root, or null once the text is final. */
const overlay = (el: HTMLElement) => el.querySelector<HTMLElement>("[data-decoding]");
/** The frame on screen: each glyph overlay, or the settled character itself. */
const frameOf = (root: HTMLElement) =>
  Array.from(root.childNodes, (n) => (n instanceof HTMLElement ? n.querySelector<HTMLElement>("[data-decode]")!.dataset.decode : n.textContent)).join("");
const TEXT = "Supprimer les pages d’un PDF";

describe("DecodeText", () => {
  it("keeps the final text as the only text content (the accessible name)", () => {
    reducedMotion(false);
    vi.useFakeTimers();
    const el = mount(<h1><DecodeText text={TEXT} trigger="mount" /></h1>);
    expect(overlay(el)).not.toBeNull();
    const glyphs = el.querySelectorAll("[data-decode]");
    expect(glyphs.length).toBeGreaterThan(0);
    for (const g of glyphs) {
      expect(g.getAttribute("aria-hidden")).toBe("true");
      expect(g.textContent).toBe("");
    }
    expect(el.querySelector("h1")!.textContent).toBe(TEXT);
  });

  it("decodes once on mount, then settles on the final text within 600 ms", () => {
    reducedMotion(false);
    vi.useFakeTimers();
    const el = mount(<DecodeText text={TEXT} trigger="mount" />);
    const first = frameOf(overlay(el)!);
    expect(Array.from(first)).toHaveLength(Array.from(TEXT).length);
    expect(first[9]).toBe(" ");
    act(() => vi.advanceTimersByTime(650));
    expect(overlay(el)).toBeNull();
    expect(el.textContent).toBe(TEXT);
  });

  it("renders the final text directly under prefers-reduced-motion", () => {
    reducedMotion(true);
    vi.useFakeTimers();
    const el = mount(<DecodeText text={TEXT} trigger="mount" />);
    expect(overlay(el)).toBeNull();
    expect(el.textContent).toBe(TEXT);
  });

  it("does nothing where matchMedia is missing (jsdom by default)", () => {
    vi.stubGlobal("matchMedia", undefined);
    const el = mount(<DecodeText text={TEXT} trigger="mount" />);
    expect(overlay(el)).toBeNull();
  });

  it("with trigger hover, decodes when the closest link is hovered or focused", () => {
    reducedMotion(false);
    vi.useFakeTimers();
    const el = mount(<a href="/merge"><DecodeText text="Merge PDF" trigger="hover" /></a>);
    expect(overlay(el)).toBeNull();
    const link = el.querySelector("a")!;
    act(() => link.dispatchEvent(new Event("pointerenter")));
    expect(overlay(el)).not.toBeNull();
    act(() => vi.advanceTimersByTime(650));
    expect(overlay(el)).toBeNull();
    act(() => link.dispatchEvent(new FocusEvent("focus")));
    expect(overlay(el)).not.toBeNull();
  });
});
