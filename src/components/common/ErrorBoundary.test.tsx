import { describe, it, expect, beforeAll, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import ErrorBoundary from "./ErrorBoundary";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

function Page({ broken }: { broken: boolean }) {
  if (broken) throw new Error("boom");
  return <p>page ok</p>;
}

describe("ErrorBoundary resetKey", () => {
  it("clears the notice when the key (the pathname) changes", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<ErrorBoundary resetKey="/merge"><Page broken /></ErrorBoundary>));
    expect(host.querySelector("[role=alert]")).not.toBeNull();

    // Same page again: the notice stays.
    act(() => root.render(<ErrorBoundary resetKey="/merge"><Page broken={false} /></ErrorBoundary>));
    expect(host.querySelector("[role=alert]")).not.toBeNull();

    // Navigation: the new page renders.
    act(() => root.render(<ErrorBoundary resetKey="/split"><Page broken={false} /></ErrorBoundary>));
    expect(host.textContent).toBe("page ok");
    spy.mockRestore();
    act(() => root.unmount());
  });
});

describe("ErrorBoundary and an old deploy's missing chunk", () => {
  function Stale(): never {
    throw new TypeError("Failed to fetch dynamically imported module: https://mantispdf.app/assets/MergePdfPage-old.js");
  }

  it("offers the new version (update panel) instead of the crash notice", async () => {
    const { __resetSwUpdateForTests, getSwUpdateView } = await import("../../pwa/swUpdate");
    __resetSwUpdateForTests();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<ErrorBoundary resetKey="/merge"><Stale /></ErrorBoundary>));
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(getSwUpdateView()).toEqual({ visible: true });
    spy.mockRestore();
    act(() => root.unmount());
    __resetSwUpdateForTests();
  });

  it("offline, it stays a crash notice (Reload would not help)", async () => {
    const { __resetSwUpdateForTests, getSwUpdateView } = await import("../../pwa/swUpdate");
    __resetSwUpdateForTests();
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<ErrorBoundary resetKey="/merge"><Stale /></ErrorBoundary>));
    expect(host.querySelector("[role=alert]")).not.toBeNull();
    expect(getSwUpdateView()).toEqual({ visible: false });
    spy.mockRestore();
    online.mockRestore();
    act(() => root.unmount());
  });
});
