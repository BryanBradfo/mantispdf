import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider, loadLocale } from "../../i18n";
import LicenseDialog from "../license/LicenseDialog";
import { DESKTOP_VERSION } from "../../lib/desktopRelease";
import { AUTO_CHECK_KEY } from "../../lib/updatePrefs";
import { __resetUpdateForTests, getUpdateView, startAutoChecks } from "../../lib/desktopUpdate";
import DesktopSettingsDialog from "./DesktopSettingsDialog";
import { getSettingsDialog, openSettings } from "../../lib/settingsDialog";

let desktop = true;
const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => check(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => Promise.resolve() }));
// The settings dialog reads the license through invoke (desktop): a free, inactive license.
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => desktop,
  invoke: (cmd: string) =>
    cmd === "get_license_status" ? Promise.resolve({ tier: "free", status: "inactive" }) : Promise.reject(new Error(cmd)),
}));

let host: HTMLDivElement;
let root: Root;

async function render(locale: "en" | "fr" = "en", focusSection: "license" | "updates" = "license") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[locale === "fr" ? "/fr" : "/"]}>
        <Suspense fallback={null}>
          <LocaleProvider>
            <LicenseDialog
              focusSection={focusSection}
              open
              onClose={() => {}}
              status={{ tier: "free", status: "inactive" }}
              onActivate={() => Promise.reject(new Error("no"))}
              onDeactivate={() => Promise.resolve()}
              checkoutUrl="https://example.test"
            />
          </LocaleProvider>
        </Suspense>
      </MemoryRouter>,
    );
  });
}

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);
const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]');

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await loadLocale("fr");
});

beforeEach(() => {
  desktop = true;
  __resetUpdateForTests();
  check.mockReset().mockResolvedValue(null);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Update settings in the license dialog", () => {
  it("are absent on the web", async () => {
    desktop = false;
    await render();
    expect(checkbox()).toBeNull();
    expect(button("Check now")).toBeUndefined();
  });

  it("toggle the automatic check (on by default) and say what it sends", async () => {
    await render();
    const box = checkbox()!;
    expect(box.checked).toBe(true);
    expect(host.textContent).toContain("Check for updates automatically");
    expect(host.textContent).toContain("Asks github.com for the latest version. No file ever leaves your computer.");
    await act(async () => box.click());
    expect(localStorage.getItem(AUTO_CHECK_KEY)).toBe("off");
    expect(checkbox()!.checked).toBe(false);
  });

  it("Check now: up to date", async () => {
    await render();
    await act(async () => button("Check now")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain(`MantisPDF ${DESKTOP_VERSION} is the latest version.`));
  });

  it("Check now: an update fills the banner's store", async () => {
    check.mockResolvedValue({ version: "9.9.9", body: "", close: () => Promise.resolve() });
    await render();
    await act(async () => button("Check now")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("MantisPDF 9.9.9 is available."));
    expect(getUpdateView()).toMatchObject({ visible: true, version: "9.9.9" });
  });

  it("Check now: a failure is a danger line, in French too", async () => {
    check.mockRejectedValue(new Error("error sending request"));
    await render("fr");
    expect(host.textContent).toContain("Rechercher les mises à jour automatiquement");
    await act(async () => button("Vérifier maintenant")!.click());
    await vi.waitFor(() => expect(host.querySelector('[role="status"].text-danger')?.textContent).toBeTruthy());
  });

  it("show the last automatic check's failure until a check succeeds", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      check.mockRejectedValue(new Error("error sending request"));
      const stop = startAutoChecks();
      await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
      stop();
      await render();
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      const line = host.querySelector("[data-last-auto-error]")!;
      expect(line.textContent).toContain("Last automatic check failed: error sending request");
      expect(line.className).toContain("text-danger");

      check.mockResolvedValue(null);
      await act(async () => button("Check now")!.click());
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(host.querySelector("[data-last-auto-error]")).toBeNull();
      expect(host.textContent).toContain("is the latest version.");
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("open focused on the automatic check toggle from the gear or the banner", async () => {
    await render("en", "updates");
    expect(document.activeElement).toBe(checkbox());
  });

  it("license first otherwise: the key input takes the focus, not the toggle", async () => {
    await render();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("License key");
  });
});

describe("DesktopSettingsDialog", () => {
  it("opens from openSettings() and closes with Escape", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <Suspense fallback={null}>
            <LocaleProvider>
              <DesktopSettingsDialog />
            </LocaleProvider>
          </Suspense>
        </MemoryRouter>,
      );
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => openSettings("updates"));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(checkbox());
    await act(async () => {
      checkbox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // The dialog then fades out (framer-motion exit); the store says it is closed.
    expect(getSettingsDialog().open).toBe(false);
  });
});
