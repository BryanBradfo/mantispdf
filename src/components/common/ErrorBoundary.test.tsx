import { describe, it, expect, beforeAll, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Suspense } from "react";
import { MemoryRouter } from "react-router-dom";
import ErrorBoundary from "./ErrorBoundary";
import { LocaleProvider } from "../../i18n";

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

  async function mount(tree: React.ReactNode) {
    const { __resetSwUpdateForTests } = await import("../../pwa/swUpdate");
    __resetSwUpdateForTests();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <MemoryRouter>
          <Suspense fallback={null}>
            <LocaleProvider>{tree}</LocaleProvider>
          </Suspense>
        </MemoryRouter>,
      ),
    );
    return {
      host,
      button: (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name),
      done: () => {
        act(() => root.unmount());
        host.remove();
        __resetSwUpdateForTests();
      },
    };
  }

  it("page boundary: the update panel (outside it) offers Reload; after Later, the crash notice", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: PwaUpdatePanel } = await import("../pwa/PwaUpdatePanel");
    const ui = await mount(
      <>
        <ErrorBoundary resetKey="/merge" staleChunkAsUpdate>
          <Stale />
        </ErrorBoundary>
        <PwaUpdatePanel />
      </>,
    );
    expect(ui.host.querySelector("[role=alert]")).toBeNull();
    expect(ui.host.querySelector('[data-testid="pwa-update"]')).not.toBeNull();
    expect(ui.button("Reload")).toBeTruthy();
    await act(async () => ui.button("Later")!.click());
    expect(ui.host.querySelector('[data-testid="pwa-update"]')).toBeNull();
    // Never an empty area: the notice and its Reload button take over.
    expect(ui.host.querySelector("[role=alert]")).not.toBeNull();
    expect(ui.button("Reload the page")).toBeTruthy();
    spy.mockRestore();
    ui.done();
  });

  it("outer boundary (it would unmount the panel): the crash notice, never a blank page", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getSwUpdateView } = await import("../../pwa/swUpdate");
    const { default: PwaUpdatePanel } = await import("../pwa/PwaUpdatePanel");
    const ui = await mount(
      <ErrorBoundary>
        <Stale />
        <PwaUpdatePanel />
      </ErrorBoundary>,
    );
    expect(ui.host.querySelector("[role=alert]")).not.toBeNull();
    expect(getSwUpdateView()).toEqual({ visible: false });
    spy.mockRestore();
    ui.done();
  });

  it("offline, the page boundary keeps the crash notice (Reload would not help)", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getSwUpdateView } = await import("../../pwa/swUpdate");
    const ui = await mount(
      <ErrorBoundary resetKey="/merge" staleChunkAsUpdate>
        <Stale />
      </ErrorBoundary>,
    );
    expect(ui.host.querySelector("[role=alert]")).not.toBeNull();
    expect(getSwUpdateView()).toEqual({ visible: false });
    spy.mockRestore();
    online.mockRestore();
    ui.done();
  });
});
