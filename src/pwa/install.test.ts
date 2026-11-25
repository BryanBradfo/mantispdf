import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetInstallForTests,
  detectPlatform,
  getInstallState,
  promptInstall,
  startInstallCapture,
  subscribeInstall,
  type NavigatorLike,
} from "./install";

const UA = {
  chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
  firefoxAndroid: "Mozilla/5.0 (Android 15; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0",
};

describe("detectPlatform", () => {
  it.each<[string, NavigatorLike, string]>([
    ["Chrome on Windows", { userAgent: UA.chromeWin }, "other"],
    ["Chrome on macOS", { userAgent: UA.chromeMac, maxTouchPoints: 0 }, "other"],
    ["Safari on macOS", { userAgent: UA.safariMac, maxTouchPoints: 0 }, "safari-mac"],
    ["Safari on iPhone", { userAgent: UA.iphone, maxTouchPoints: 5 }, "ios"],
    ["Chrome on iPhone", { userAgent: UA.chromeIos, maxTouchPoints: 5 }, "ios"],
    ["iPadOS (a Mac user agent with touch)", { userAgent: UA.safariMac, maxTouchPoints: 5 }, "ios"],
    ["Firefox on Linux", { userAgent: UA.firefoxLinux }, "firefox-desktop"],
    ["Firefox on Android (it can install)", { userAgent: UA.firefoxAndroid }, "other"],
  ])("%s", (_name, nav, expected) => {
    expect(detectPlatform(nav)).toBe(expected);
  });
});

/** A window double: dispatches the events the capture listens to. */
function fakeWindow(nav: NavigatorLike, displayMode: string | null = null) {
  const target = new EventTarget();
  return {
    navigator: nav,
    matchMedia: (q: string) => ({ matches: displayMode !== null && q === `(display-mode: ${displayMode})` }),
    addEventListener: (type: string, l: (e: Event) => void) => target.addEventListener(type, l),
    dispatch: (e: Event) => target.dispatchEvent(e),
  };
}

function installPrompt(outcome: "accepted" | "dismissed") {
  const e = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn(() => Promise.resolve());
  Object.assign(e, { prompt, userChoice: Promise.resolve({ outcome }) });
  return { event: e, prompt };
}

beforeEach(() => __resetInstallForTests());

describe("install state", () => {
  it("captures the prompt, keeps it from the browser's own bar, and offers the button", () => {
    const win = fakeWindow({ userAgent: UA.chromeWin });
    startInstallCapture(win);
    expect(getInstallState()).toBe("unavailable");
    const listener = vi.fn();
    subscribeInstall(listener);
    const { event } = installPrompt("accepted");
    win.dispatch(event);
    expect(event.defaultPrevented).toBe(true);
    expect(getInstallState()).toBe("available");
    expect(listener).toHaveBeenCalled();
  });

  it("accepted: shows the browser dialog once and ends installed", async () => {
    const win = fakeWindow({ userAgent: UA.chromeWin });
    startInstallCapture(win);
    const { event, prompt } = installPrompt("accepted");
    win.dispatch(event);
    expect(await promptInstall()).toBe("accepted");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(getInstallState()).toBe("installed");
    expect(await promptInstall()).toBe("unavailable");
  });

  it("dismissed: the used prompt is dropped (the browser may offer a new one later)", async () => {
    const win = fakeWindow({ userAgent: UA.chromeWin });
    startInstallCapture(win);
    win.dispatch(installPrompt("dismissed").event);
    expect(await promptInstall()).toBe("dismissed");
    expect(getInstallState()).toBe("unavailable");
    win.dispatch(installPrompt("accepted").event);
    expect(getInstallState()).toBe("available");
  });

  it("appinstalled (from the browser's own menu) ends installed", () => {
    const win = fakeWindow({ userAgent: UA.chromeWin });
    startInstallCapture(win);
    win.dispatch(installPrompt("accepted").event);
    win.dispatch(new Event("appinstalled"));
    expect(getInstallState()).toBe("installed");
  });

  it("already running as the installed app: standalone, nothing to offer", () => {
    const win = fakeWindow({ userAgent: UA.chromeWin }, "standalone");
    startInstallCapture(win);
    win.dispatch(installPrompt("accepted").event);
    expect(getInstallState()).toBe("standalone");
  });

  it("iOS home screen app (navigator.standalone) is standalone too", () => {
    startInstallCapture(fakeWindow({ userAgent: UA.iphone, maxTouchPoints: 5, standalone: true }));
    expect(getInstallState()).toBe("standalone");
  });

  it.each<[string, NavigatorLike, string]>([
    ["iOS: Share, then Add to Home Screen", { userAgent: UA.iphone, maxTouchPoints: 5 }, "ios"],
    ["Safari on macOS: Add to Dock", { userAgent: UA.safariMac, maxTouchPoints: 0 }, "safari-mac"],
    ["Firefox desktop: the desktop app", { userAgent: UA.firefoxLinux }, "firefox-desktop"],
  ])("%s", (_name, nav, expected) => {
    startInstallCapture(fakeWindow(nav));
    expect(getInstallState()).toBe(expected);
  });
});
