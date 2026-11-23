import { isTauri } from "@tauri-apps/api/core";
import { startInstallCapture } from "./install";
import { startSwUpdates, type RegisterSW } from "./swUpdate";

/** vite-plugin-pwa's register module (workbox-window), loaded only where a service worker is wanted. */
const loadRegister = async (): Promise<RegisterSW> => (await import("virtual:pwa-register")).registerSW;

/**
 * The web app's startup, from main.tsx before React mounts: capture the install prompt and register the
 * service worker (production build only: `vite` dev has none). Never in the Tauri desktop app, which serves
 * the same dist/ and updates itself (lib/desktopUpdate.ts).
 */
export function startPwa(deps: { production?: boolean; load?: () => Promise<RegisterSW> } = {}): void {
  if (isTauri()) return;
  startInstallCapture(window);
  const production = deps.production ?? import.meta.env.PROD;
  if (!production || !("serviceWorker" in navigator)) return;
  void (deps.load ?? loadRegister)()
    .then((register) => startSwUpdates(register))
    .catch((error: unknown) => console.warn("Service worker unavailable", error));
}
