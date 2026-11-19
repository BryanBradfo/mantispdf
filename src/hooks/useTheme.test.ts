import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let result: ReturnType<typeof useTheme>;
function Probe() {
  result = useTheme();
  return null;
}
function mount() {
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  return root;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => vi.unstubAllGlobals());

describe("useTheme", () => {
  it("defaults to dark with no stored value even when the system is light", () => {
    mount();
    expect(result[0]).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
  it("a stored light choice wins", () => {
    localStorage.setItem("theme", "light");
    mount();
    expect(result[0]).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
  it("setDark(false) removes the class and stores light", () => {
    mount();
    act(() => result[1](false));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });
  it("falls back to dark when storage cannot be read, and ignores a failed write", () => {
    const failing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
    };
    vi.stubGlobal("localStorage", failing);
    expect(() => mount()).not.toThrow();
    expect(result[0]).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(() => act(() => result[1](false))).not.toThrow();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
