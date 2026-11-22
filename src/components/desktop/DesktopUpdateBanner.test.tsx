import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { LocaleProvider, loadLocale } from "../../i18n";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";

const check = vi.fn();
const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => check(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));

import DesktopUpdateBanner from "./DesktopUpdateBanner";
import { __resetUpdateForTests, checkNow } from "../../lib/desktopUpdate";
import { closeSettings, getSettingsDialog } from "../../lib/settingsDialog";

let host: HTMLDivElement;
let root: Root;
/** Lets the test drive the download events. */
let emit: (e: DownloadEvent) => void = () => {};
let finish: (err?: unknown) => void = () => {};

function offer(version = "2.2.0", body = "Faster merge\nDetails") {
  check.mockResolvedValue({
    version,
    body,
    close: () => Promise.resolve(),
    downloadAndInstall: (onEvent: (e: DownloadEvent) => void) =>
      new Promise<void>((resolve, reject) => {
        emit = onEvent;
        finish = (err) => (err === undefined ? resolve() : reject(err));
      }),
  });
}

async function render(locale: "en" | "fr" = "en") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[locale === "fr" ? "/fr" : "/"]}>
        <Suspense fallback={null}>
          <LocaleProvider>
            <DesktopUpdateBanner />
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
  __resetUpdateForTests();
  check.mockReset().mockResolvedValue(null);
  relaunch.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("DesktopUpdateBanner", () => {
  it("shows nothing while there is no update", async () => {
    await render();
    await act(async () => void (await checkNow()));
    expect(panel()).toBeNull();
  });

  it("announces the version and the notes' first line, without taking the focus", async () => {
    offer();
    await render();
    const before = document.activeElement;
    await act(async () => void (await checkNow()));
    const p = panel()!;
    expect(p.getAttribute("aria-live")).toBe("polite");
    expect(p.textContent).toContain("Update");
    expect(p.textContent).toContain("MantisPDF 2.2.0 is available");
    expect(p.textContent).toContain("Faster merge");
    expect(p.textContent).not.toContain("Details");
    expect(button("Install and restart")).toBeTruthy();
    expect(button("Later")).toBeTruthy();
    expect(document.activeElement).toBe(before);
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
    expect(host.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(p.textContent).not.toMatch(/[·—]/);
  });

  it("speaks French", async () => {
    offer("2.2.0", "");
    await render("fr");
    await act(async () => void (await checkNow()));
    expect(panel()!.textContent).toContain("MantisPDF 2.2.0 est disponible");
    expect(button("Installer et redémarrer")).toBeTruthy();
    expect(button("Plus tard")).toBeTruthy();
  });

  it("Install shows the download progress, then relaunches", async () => {
    offer();
    await render();
    await act(async () => void (await checkNow()));
    await act(async () => button("Install and restart").click());
    await act(async () => {
      emit({ event: "Started", data: { contentLength: 200 } });
      emit({ event: "Progress", data: { chunkLength: 100 } });
    });
    const bar = host.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(panel()!.textContent).toContain("Downloading 50%");
    expect(button("Later").disabled).toBe(true);
    await act(async () => {
      emit({ event: "Finished" });
      finish();
    });
    expect(panel()!.textContent).toContain("Restarting…");
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("a failed install shows a danger line and lets the person try again", async () => {
    offer();
    await render();
    await act(async () => void (await checkNow()));
    await act(async () => button("Install and restart").click());
    await act(async () => finish(new Error("signature verification failed")));
    const line = host.querySelector(".text-danger")!;
    expect(line.textContent).toContain("signature verification failed");
    expect(button("Install and restart").disabled).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("Later and Escape hide it", async () => {
    offer();
    await render();
    await act(async () => void (await checkNow()));
    await act(async () => button("Later").click());
    expect(panel()).toBeNull();

    await act(async () => void (await checkNow()));
    expect(panel()).not.toBeNull();
    await act(async () => {
      button("Later").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  it("a failed relaunch asks for a restart instead of offering the install again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    relaunch.mockRejectedValue(new Error("no"));
    offer();
    await render();
    await act(async () => void (await checkNow()));
    await act(async () => button("Install and restart").click());
    await act(async () => finish());
    expect(panel()!.textContent).toContain("Restart MantisPDF to finish the update.");
    expect(button("Install and restart")).toBeUndefined();
    expect(button("Later").disabled).toBe(false);
    warn.mockRestore();
  });

  it("a package this install cannot apply sends the person to the download page", async () => {
    offer();
    await render("fr");
    await act(async () => void (await checkNow()));
    await act(async () => button("Installer et redémarrer").click());
    await act(async () => finish("invalid updater binary format"));
    const line = host.querySelector(".text-danger")!;
    expect(line.textContent).toBe("Mettez à jour depuis la page de téléchargement.");
    expect(line.querySelector("a")!.getAttribute("href")).toBe("/fr/download");
  });

  it("Settings opens the settings dialog on the update settings", async () => {
    closeSettings();
    offer();
    await render();
    await act(async () => void (await checkNow()));
    await act(async () => button("Settings").click());
    expect(getSettingsDialog()).toEqual({ open: true, section: "updates" });
    closeSettings();
  });
});
