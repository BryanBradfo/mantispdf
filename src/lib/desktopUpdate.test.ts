import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

const check = vi.fn();
const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => check(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));

import {
  __resetUpdateForTests,
  checkNow,
  dismissUpdate,
  firstNotesLine,
  getUpdateView,
  installUpdate,
  progressPercent,
  startAutoChecks,
} from "./desktopUpdate";
import { AUTO_CHECK_KEY, readAutoCheck, writeAutoCheck } from "./updatePrefs";

/** A fake `Update` whose download succeeds at once (or fails with `fail`). */
function fakeUpdate(opts: { version?: string; body?: string; fail?: unknown } = {}) {
  return {
    version: opts.version ?? "2.2.0",
    body: opts.body,
    close: vi.fn(() => Promise.resolve()),
    downloadAndInstall: vi.fn(async (_onEvent?: (e: DownloadEvent) => void) => {
      if (opts.fail !== undefined) throw opts.fail;
    }),
  };
}

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  __resetUpdateForTests();
  check.mockReset();
  relaunch.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("update preference", () => {
  it("is on by default, and remembers off", () => {
    expect(readAutoCheck()).toBe(true);
    writeAutoCheck(false);
    expect(localStorage.getItem(AUTO_CHECK_KEY)).toBe("off");
    expect(readAutoCheck()).toBe(false);
    writeAutoCheck(true);
    expect(readAutoCheck()).toBe(true);
  });

  it("falls back to on when storage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readAutoCheck()).toBe(true);
    spy.mockRestore();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeAutoCheck(false)).not.toThrow();
    set.mockRestore();
  });
});

describe("automatic checks", () => {
  it("wait 5 s, then check every 6 h", async () => {
    vi.useFakeTimers();
    check.mockResolvedValue(null);
    const stop = startAutoChecks();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("no update: nothing to show", async () => {
    vi.useFakeTimers();
    check.mockResolvedValue(null);
    startAutoChecks();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getUpdateView().visible).toBe(false);
  });

  it("an update: the view names its version and the first line of its notes", async () => {
    vi.useFakeTimers();
    check.mockResolvedValue(fakeUpdate({ version: "2.2.0", body: "\n## Faster merge\nMore details" }));
    startAutoChecks();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getUpdateView()).toMatchObject({ visible: true, version: "2.2.0", notes: "Faster merge", phase: "idle" });
  });

  it("setting off: never calls the network", async () => {
    vi.useFakeTimers();
    writeAutoCheck(false);
    check.mockResolvedValue(fakeUpdate());
    startAutoChecks();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(check).not.toHaveBeenCalled();
  });

  it("offline or any failure: silent, no error in the view", async () => {
    vi.useFakeTimers();
    check.mockRejectedValue(new Error("error sending request"));
    startAutoChecks();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getUpdateView()).toMatchObject({ visible: false, error: null });
  });

  it("Later: hidden, and later automatic checks keep it hidden until the next launch", async () => {
    vi.useFakeTimers();
    check.mockResolvedValue(fakeUpdate());
    startAutoChecks();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getUpdateView().visible).toBe(true);
    dismissUpdate();
    expect(getUpdateView().visible).toBe(false);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(check).toHaveBeenCalledTimes(2);
    expect(getUpdateView().visible).toBe(false);
  });
});

describe("checkNow", () => {
  it("reports the latest version, or shows an update even after Later", async () => {
    check.mockResolvedValueOnce(null);
    expect(await checkNow()).toBe("latest");
    check.mockResolvedValue(fakeUpdate());
    await checkNow();
    dismissUpdate();
    expect(await checkNow()).toBe("available");
    expect(getUpdateView().visible).toBe(true);
  });

  it("throws on failure (the settings show it)", async () => {
    check.mockRejectedValue(new Error("offline"));
    await expect(checkNow()).rejects.toThrow("offline");
  });
});

describe("installUpdate", () => {
  it("tracks download progress, then relaunches", async () => {
    const seen: (number | null)[] = [];
    const update = fakeUpdate();
    update.downloadAndInstall.mockImplementation(async (onEvent?: (e: DownloadEvent) => void) => {
      for (const e of [
        { event: "Started", data: { contentLength: 1000 } },
        { event: "Progress", data: { chunkLength: 250 } },
        { event: "Progress", data: { chunkLength: 500 } },
      ] as DownloadEvent[]) {
        onEvent?.(e);
        seen.push(progressPercent(getUpdateView()));
      }
      onEvent?.({ event: "Finished" });
    });
    check.mockResolvedValue(update);
    await checkNow();
    await installUpdate();
    expect(seen).toEqual([0, 25, 75]);
    expect(getUpdateView().phase).toBe("restarting");
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("an unknown size gives no percent", async () => {
    const update = fakeUpdate();
    let percent: number | null = -1;
    update.downloadAndInstall.mockImplementation(async (onEvent?: (e: DownloadEvent) => void) => {
      onEvent?.({ event: "Started", data: {} });
      onEvent?.({ event: "Progress", data: { chunkLength: 10 } });
      percent = progressPercent(getUpdateView());
    });
    check.mockResolvedValue(update);
    await checkNow();
    await installUpdate();
    expect(percent).toBeNull();
  });

  it("a failed download keeps the panel with the error, and can be retried", async () => {
    check.mockResolvedValue(fakeUpdate({ fail: new Error("signature verification failed") }));
    await checkNow();
    await expect(installUpdate()).resolves.toBeUndefined();
    const view = getUpdateView();
    expect(view).toMatchObject({ visible: true, phase: "idle" });
    expect(String(view.error)).toContain("signature verification failed");
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe("firstNotesLine", () => {
  it("keeps the first non-empty line without markdown heading marks", () => {
    expect(firstNotesLine(undefined)).toBeNull();
    expect(firstNotesLine("  \n\n")).toBeNull();
    expect(firstNotesLine("### New: bates numbers\r\nsecond")).toBe("New: bates numbers");
    expect(firstNotesLine("- Faster split")).toBe("Faster split");
  });
});
