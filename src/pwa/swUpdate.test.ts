import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";
import { __resetSwUpdateForTests, applyUpdate, dismissSwUpdate, getSwUpdateView, startSwUpdates, subscribeSwUpdate } from "./swUpdate";

/** A fake vite-plugin-pwa registerSW: the test fires its callbacks. */
function fakeRegister() {
  let options: RegisterSWOptions = {};
  const updateSW = vi.fn(() => Promise.resolve());
  const register = vi.fn((o: RegisterSWOptions = {}) => {
    options = o;
    return updateSW;
  });
  return { register, updateSW, fire: () => options };
}

let reload: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  __resetSwUpdateForTests();
  reload = vi.fn<() => void>();
});

afterEach(() => vi.useRealTimers());

describe("service worker updates", () => {
  it("registers once, immediately, and shows nothing until a new version waits", () => {
    const sw = fakeRegister();
    startSwUpdates(sw.register, { reload });
    startSwUpdates(sw.register, { reload });
    expect(sw.register).toHaveBeenCalledTimes(1);
    expect(sw.register.mock.calls[0][0]).toMatchObject({ immediate: true });
    expect(getSwUpdateView()).toEqual({ visible: false });
    sw.fire().onOfflineReady?.();
    expect(getSwUpdateView()).toEqual({ visible: false });
  });

  it("shows the panel when a new service worker is waiting, and notifies subscribers", () => {
    const sw = fakeRegister();
    startSwUpdates(sw.register, { reload });
    const listener = vi.fn();
    const off = subscribeSwUpdate(listener);
    sw.fire().onNeedRefresh?.();
    expect(getSwUpdateView()).toEqual({ visible: true });
    expect(listener).toHaveBeenCalled();
    off();
  });

  it("Reload activates the waiting worker, then reloads once it controls the page", async () => {
    const sw = fakeRegister();
    startSwUpdates(sw.register, { reload });
    sw.fire().onNeedRefresh?.();
    await applyUpdate();
    expect(sw.updateSW).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    sw.fire().onNeedReload?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads by itself when another tab activated the new version: it offers Reload instead", async () => {
    const sw = fakeRegister();
    startSwUpdates(sw.register, { reload });
    sw.fire().onNeedRefresh?.();
    dismissSwUpdate();
    sw.fire().onNeedReload?.();
    expect(reload).not.toHaveBeenCalled();
    expect(getSwUpdateView()).toEqual({ visible: true });
    // The new worker already runs: Reload just reloads.
    await applyUpdate();
    expect(sw.updateSW).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("Later hides the panel until the next version", () => {
    const sw = fakeRegister();
    startSwUpdates(sw.register, { reload });
    sw.fire().onNeedRefresh?.();
    dismissSwUpdate();
    expect(getSwUpdateView()).toEqual({ visible: false });
    sw.fire().onNeedRefresh?.();
    expect(getSwUpdateView()).toEqual({ visible: true });
  });

  it("checks for a new version every hour while online", () => {
    vi.useFakeTimers();
    const sw = fakeRegister();
    startSwUpdates(sw.register, { reload });
    const update = vi.fn(() => Promise.resolve());
    sw.fire().onRegisteredSW?.("/sw.js", { installing: null, update } as unknown as ServiceWorkerRegistration);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("stale code", () => {
  it("recognises a failed dynamic import in each engine, and nothing else", async () => {
    const { isStaleCodeError } = await import("./swUpdate");
    expect(isStaleCodeError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/a.js"))).toBe(true);
    expect(isStaleCodeError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleCodeError(new TypeError("error loading dynamically imported module: https://x/a.js"))).toBe(true);
    expect(isStaleCodeError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true);
    expect(isStaleCodeError(new Error("boom"))).toBe(false);
    expect(isStaleCodeError(null)).toBe(false);
  });

  it("a stale chunk shows the panel, and Reload just reloads", async () => {
    const { reportStaleCode } = await import("./swUpdate");
    const sw = fakeRegister();
    startSwUpdates(sw.register, { reload });
    reportStaleCode();
    expect(getSwUpdateView()).toEqual({ visible: true });
    await applyUpdate();
    expect(sw.updateSW).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
