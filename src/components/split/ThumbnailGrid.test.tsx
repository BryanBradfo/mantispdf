import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import ThumbnailGrid from "./ThumbnailGrid";

class Idle {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", Idle);
  vi.stubGlobal("IntersectionObserver", Idle);
});
afterAll(() => vi.unstubAllGlobals());

describe("ThumbnailGrid split points", () => {
  it("says which dividers are split points with aria-pressed", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<ThumbnailGrid source={new Blob()} numPages={3} splitPoints={new Set([1])} onToggleSplit={() => {}} />));
    // Divider after page 1, divider after page 2, then the row cut (not every point of the row is set).
    const pressed = [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["true", "false", "false"]);
    act(() => root.unmount());
  });
});
