import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider, loadLocale } from "../../i18n";
import LicenseDialog from "../license/LicenseDialog";
import { DESKTOP_VERSION } from "../../lib/desktopRelease";
import { AUTO_CHECK_KEY } from "../../lib/updatePrefs";
import { __resetUpdateForTests, getUpdateView } from "../../lib/desktopUpdate";

let desktop = true;
const check = vi.fn();
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => desktop,
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => check(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => Promise.resolve() }));

let host: HTMLDivElement;
let root: Root;

async function render(locale: "en" | "fr" = "en") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[locale === "fr" ? "/fr" : "/"]}>
        <Suspense fallback={null}>
          <LocaleProvider>
            <LicenseDialog
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
});
