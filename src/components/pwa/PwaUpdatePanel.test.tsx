import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";
import { LocaleProvider, loadLocale } from "../../i18n";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";
import PwaUpdatePanel from "./PwaUpdatePanel";
import { __resetSwUpdateForTests, startSwUpdates } from "../../pwa/swUpdate";

let host: HTMLDivElement;
let root: Root;
let sw: RegisterSWOptions = {};
const updateSW = vi.fn(() => Promise.resolve());
const reload = vi.fn();

async function render(locale: "en" | "fr" = "en") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[locale === "fr" ? "/fr" : "/"]}>
        <Suspense fallback={null}>
          <LocaleProvider>
            <PwaUpdatePanel />
          </LocaleProvider>
        </Suspense>
      </MemoryRouter>,
    );
  });
}

const panel = () => host.querySelector<HTMLElement>('[role="status"]');
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await loadLocale("fr");
});

beforeEach(() => {
  __resetSwUpdateForTests();
  updateSW.mockClear();
  reload.mockClear();
  startSwUpdates(
    (o = {}) => {
      sw = o;
      return updateSW;
    },
    { reload },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("PwaUpdatePanel", () => {
  it("shows nothing while no new version waits", async () => {
    await render();
    expect(panel()).toBeNull();
  });

  it("appears when a new service worker waits, without taking the focus, in black and white", async () => {
    await render();
    const before = document.activeElement;
    await act(async () => sw.onNeedRefresh?.());
    const p = panel()!;
    expect(p.getAttribute("aria-live")).toBe("polite");
    expect(p.textContent).toContain("A new version of MantisPDF is ready");
    expect(button("Reload")).toBeTruthy();
    expect(button("Later")).toBeTruthy();
    expect(document.activeElement).toBe(before);
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
    expect(p.textContent).not.toMatch(/[·—]/);
  });

  it("speaks French", async () => {
    await render("fr");
    await act(async () => sw.onNeedRefresh?.());
    expect(panel()!.textContent).toContain("Une nouvelle version de MantisPDF est prête");
    expect(button("Recharger")).toBeTruthy();
    expect(button("Plus tard")).toBeTruthy();
  });

  it("Reload activates the new version; the page reloads only once it is in control", async () => {
    await render();
    await act(async () => sw.onNeedRefresh?.());
    await act(async () => button("Reload").click());
    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    sw.onNeedReload?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads by itself when another tab installed the new version", async () => {
    await render();
    await act(async () => sw.onNeedReload?.());
    expect(reload).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
  });

  it("Later and Escape hide it", async () => {
    await render();
    await act(async () => sw.onNeedRefresh?.());
    await act(async () => button("Later").click());
    expect(panel()).toBeNull();
    await act(async () => sw.onNeedRefresh?.());
    await act(async () => {
      button("Reload").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panel()).toBeNull();
    expect(updateSW).not.toHaveBeenCalled();
  });
});
