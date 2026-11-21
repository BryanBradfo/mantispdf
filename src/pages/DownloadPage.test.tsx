import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { LocaleProvider, loadLocale } from "../i18n";
import { BANNED_COLOR_PATTERN } from "../styles/rawColors";
import { assetUrl, linuxInstallCommand } from "../lib/desktopRelease";
import DownloadPage from "./DownloadPage";

let root: Root;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(path = "/download", platform = "Linux") {
  vi.stubGlobal("navigator", { ...navigator, userAgent: "test", userAgentData: { platform } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <HelmetProvider>
        <MemoryRouter initialEntries={[path]}>
          <Suspense fallback={null}>
            <LocaleProvider>
              <DownloadPage />
            </LocaleProvider>
          </Suspense>
        </MemoryRouter>
      </HelmetProvider>,
    );
  });
  if (path.startsWith("/fr")) await act(async () => void (await loadLocale("fr")));
}

const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const selected = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const panel = () => host.querySelector<HTMLElement>('[role="tabpanel"]')!;
const links = () => [...panel().querySelectorAll<HTMLAnchorElement>("a[download]")].map((a) => a.href);
const key = (el: HTMLElement, k: string) =>
  act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

describe("DownloadPage", () => {
  it("shows the eyebrow, the title and three OS tabs, the visitor's OS selected", async () => {
    await render("/download", "Windows");
    expect(host.querySelector('[data-testid="download-eyebrow"]')?.textContent).toBe("Desktop app");
    expect(host.querySelector('[data-testid="download-eyebrow"] svg')).not.toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("MantisPDF for your desktop");
    expect(tabs().map((t) => t.textContent)).toEqual(["macOS", "Windows", "Linux"]);
    expect(selected()).toBe("Windows");
    expect(links()).toEqual([assetUrl("winExe"), assetUrl("winMsi")]);
    expect(panel().getAttribute("aria-labelledby")).toBe(tabs()[1].id);
  });

  it("moves between tabs with the arrow keys, Home and End, keeping one tab stop", async () => {
    await render("/download", "macOS");
    expect(selected()).toBe("macOS");
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    await key(tabs()[0], "ArrowRight");
    expect(selected()).toBe("Windows");
    expect(document.activeElement).toBe(tabs()[1]);
    await key(tabs()[1], "ArrowRight");
    expect(selected()).toBe("Linux");
    await key(tabs()[2], "ArrowRight");
    expect(selected()).toBe("macOS");
    await key(tabs()[0], "ArrowLeft");
    expect(selected()).toBe("Linux");
    await key(tabs()[2], "Home");
    expect(selected()).toBe("macOS");
    await key(tabs()[0], "End");
    expect(selected()).toBe("Linux");
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("preselects the tab named by ?os=, over the visitor's OS", async () => {
    await render("/download?os=linux", "Windows");
    expect(selected()).toBe("Linux");
    expect(links()).toEqual([assetUrl("appImage"), assetUrl("deb"), assetUrl("rpm")]);
  });

  it("falls back to the visitor's OS when ?os= is unknown", async () => {
    await render("/download?os=beos", "Windows");
    expect(selected()).toBe("Windows");
  });

  it("lists the Mac and Linux installers and the Linux one-liner", async () => {
    await render("/download", "macOS");
    expect(links()).toEqual([assetUrl("macArm"), assetUrl("macIntel")]);
    expect(panel().textContent).toContain("right-click");
    await act(async () => tabs()[2].click());
    expect(links()).toEqual([assetUrl("appImage"), assetUrl("deb"), assetUrl("rpm")]);
    expect(panel().querySelector("code")?.textContent).toBe(linuxInstallCommand());
  });

  it("copies the Linux command and says so", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    await render("/download", "Linux");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const copy = panel().querySelector<HTMLButtonElement>('button[aria-label="Copy command"]')!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith(linuxInstallCommand());
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Copied");
  });

  it("is in French under /fr, on the tokens only", async () => {
    await render("/fr/download", "Linux");
    expect(host.querySelector("h1")?.textContent).toBe("MantisPDF sur votre ordinateur");
    expect(host.querySelector('[data-testid="download-eyebrow"]')?.textContent).toBe("Application de bureau");
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
  });
});
