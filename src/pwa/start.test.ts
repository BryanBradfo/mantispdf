import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ on: false }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri.on }));

import { startPwa } from "./start";
import { __resetSwUpdateForTests } from "./swUpdate";
import { __resetInstallForTests, getInstallState } from "./install";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetSwUpdateForTests();
  __resetInstallForTests();
  Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
});

afterEach(() => {
  tauri.on = false;
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("startPwa", () => {
  it("registers the service worker in the production web app", async () => {
    const register = vi.fn(() => () => Promise.resolve());
    startPwa({ production: true, load: () => Promise.resolve(register) });
    await flush();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("never registers a service worker nor captures the install prompt in the Tauri app", async () => {
    tauri.on = true;
    const load = vi.fn(() => Promise.resolve(vi.fn()));
    const listen = vi.spyOn(window, "addEventListener");
    startPwa({ production: true, load });
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(listen.mock.calls.map((c) => c[0])).not.toContain("beforeinstallprompt");
    expect(getInstallState()).toBe("unavailable");
    listen.mockRestore();
  });

  it("registers nothing in the dev server", async () => {
    const load = vi.fn(() => Promise.resolve(vi.fn()));
    startPwa({ production: false, load });
    await flush();
    expect(load).not.toHaveBeenCalled();
  });
});
