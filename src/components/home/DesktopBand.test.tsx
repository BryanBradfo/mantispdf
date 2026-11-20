import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider, loadLocale, localeFromPath } from "../../i18n";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";
import DesktopBand from "./DesktopBand";

const tauri = vi.hoisted(() => ({ on: false }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri.on }));

let root: Root;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  tauri.on = false;
});

async function renderAt(path: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={null}>
          <LocaleProvider>
            <DesktopBand />
          </LocaleProvider>
        </Suspense>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await loadLocale(localeFromPath(path)).catch(() => {});
  });
}

const tiles = () => [...host.querySelectorAll<HTMLAnchorElement>("li a")];

describe("DesktopBand", () => {
  it("shows the title, the subtitle and three OS tiles linking to their download tab", async () => {
    await renderAt("/");
    const section = host.querySelector("section")!;
    expect(section.querySelector("h2")?.textContent).toBe("MantisPDF Desktop App");
    expect(section.getAttribute("aria-labelledby")).toBe(section.querySelector("h2")?.id);
    expect(section.textContent).toContain("Available on every computer.");
    expect(tiles().map((a) => a.getAttribute("href"))).toEqual([
      "/download?os=mac",
      "/download?os=windows",
      "/download?os=linux",
    ]);
    expect(tiles().map((a) => a.textContent)).toEqual([
      "Apple Silicon & IntelmacOS",
      "Windows 10 & 11Windows",
      "AppImage · deb · rpmLinux",
    ]);
    for (const a of tiles()) expect(a.querySelector("svg")).not.toBeNull();
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
  });

  it("is in French under /fr, with localized links", async () => {
    await renderAt("/fr");
    expect(host.querySelector("h2")?.textContent).toBe("MantisPDF pour ordinateur");
    expect(host.textContent).toContain("Disponible sur tous les ordinateurs.");
    expect(tiles().map((a) => a.getAttribute("href"))).toEqual([
      "/fr/download?os=mac",
      "/fr/download?os=windows",
      "/fr/download?os=linux",
    ]);
    expect(tiles()[0].textContent).toBe("Apple Silicon et IntelmacOS");
    expect(tiles()[1].textContent).toBe("Windows 10 et 11Windows");
  });

  it("is not rendered inside the desktop app", async () => {
    tauri.on = true;
    await renderAt("/");
    expect(host.querySelector("section")).toBeNull();
    expect(host.textContent).toBe("");
  });
});
