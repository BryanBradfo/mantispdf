/**
 * "Install MantisPDF" as a web app. Chromium (Chrome, Edge, Android browsers) fires `beforeinstallprompt`:
 * it is kept (captured at startup by `start.ts`, before React mounts, so it is not missed) and the install
 * card or the footer link calls `promptInstall()`. iOS and iPadOS have no prompt (Share, then Add to Home
 * Screen), Safari on macOS uses File, then Add to Dock, and Firefox on the desktop cannot install web apps.
 * Never captured in the Tauri app (`start.ts`), and the UI hides itself there and when already installed.
 */

/** Chromium's install prompt event (not in the DOM typings). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
}

export type InstallPlatform = "ios" | "safari-mac" | "firefox-desktop" | "other";

/**
 * - `standalone`: running as the installed app: offer nothing;
 * - `installed`: installed from this tab just now;
 * - `available`: the browser's install prompt is ready (button);
 * - `ios`, `safari-mac`, `firefox-desktop`: instructions for that browser;
 * - `unavailable`: no prompt (not offered yet, or refused this session): point to the browser's menu.
 */
export type InstallState = "standalone" | "installed" | "available" | "ios" | "safari-mac" | "firefox-desktop" | "unavailable";

export interface NavigatorLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
}

export function detectPlatform(nav: NavigatorLike): InstallPlatform {
  const ua = nav.userAgent;
  // iPadOS reports itself as a Mac; a touch screen tells them apart.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)) return "ios";
  if (/Firefox\//.test(ua) && !/Android|Mobile/.test(ua)) return "firefox-desktop";
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox/.test(ua)) return "safari-mac";
  return "other";
}

interface WindowLike {
  navigator: NavigatorLike;
  matchMedia?: (query: string) => { matches: boolean };
  addEventListener(type: string, listener: (e: Event) => void): void;
}

export function isStandalone(win: WindowLike): boolean {
  const mode = (q: string) => win.matchMedia?.(`(display-mode: ${q})`).matches === true;
  return mode("standalone") || mode("window-controls-overlay") || mode("fullscreen") || win.navigator.standalone === true;
}

let platform: InstallPlatform = "other";
let standalone = false;
let installed = false;
let prompt: BeforeInstallPromptEvent | null = null;
let started = false;
let state: InstallState = "unavailable";
const listeners = new Set<() => void>();

function update() {
  const next: InstallState = standalone
    ? "standalone"
    : installed
      ? "installed"
      : prompt
        ? "available"
        : platform === "other"
          ? "unavailable"
          : platform;
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getInstallState = (): InstallState => state;

/** Start listening for the install prompt and the end of an install (once). */
export function startInstallCapture(win: WindowLike = window): void {
  if (started) return;
  started = true;
  platform = detectPlatform(win.navigator);
  standalone = isStandalone(win);
  win.addEventListener("beforeinstallprompt", (e) => {
    // Keep it for our own button instead of the browser's mini info bar.
    e.preventDefault();
    prompt = e as BeforeInstallPromptEvent;
    update();
  });
  win.addEventListener("appinstalled", () => {
    prompt = null;
    installed = true;
    update();
  });
  update();
}

/** Shows the browser's install dialog; a prompt works once, whatever the answer. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = prompt;
  if (!event) return "unavailable";
  prompt = null;
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === "accepted") installed = true;
    return outcome;
  } catch {
    return "unavailable";
  } finally {
    update();
  }
}

export function __resetInstallForTests(): void {
  platform = "other";
  standalone = false;
  installed = false;
  prompt = null;
  started = false;
  state = "unavailable";
  listeners.clear();
}
