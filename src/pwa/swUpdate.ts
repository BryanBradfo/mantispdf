import type { RegisterSWOptions } from "vite-plugin-pwa/types";

/**
 * The web app's service worker updates (registerType "prompt"): a new deploy installs a new worker that
 * WAITS; `PwaUpdatePanel` offers Reload or Later. Nothing ever reloads a page by itself, so a file open in
 * a tool is never lost: when another tab chose Reload (the new worker then controls this tab too), this tab
 * only offers Reload again.
 *
 * `register` is vite-plugin-pwa's `registerSW` (from `virtual:pwa-register`, loaded by `start.ts`).
 */
export type RegisterSW = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>;

export interface SwUpdateView {
  /** A new version is ready and the person has not chosen Later for it. */
  visible: boolean;
}

const HOURLY = 60 * 60 * 1000;

let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
let doReload: () => void = () => window.location.reload();
/** This tab asked for the new version (Reload): reload as soon as it controls the page. */
let requested = false;
/** The new worker already controls this tab (another tab activated it). */
let activated = false;
let view: SwUpdateView = { visible: false };
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function setVisible(visible: boolean) {
  if (view.visible === visible) return;
  view = { visible };
  listeners.forEach((l) => l());
}

export function subscribeSwUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getSwUpdateView = (): SwUpdateView => view;

/** Registers the service worker once and starts listening for new versions. */
export function startSwUpdates(register: RegisterSW, options: { reload?: () => void } = {}): void {
  if (updateSW) return;
  if (options.reload) doReload = options.reload;
  updateSW = register({
    immediate: true,
    onNeedRefresh: () => setVisible(true),
    onNeedReload: () => {
      if (requested) return doReload();
      activated = true;
      setVisible(true);
    },
    onRegisteredSW: (_url, registration) => {
      if (!registration) return;
      // An installed app can stay open for days: look for a new deploy every hour (online only).
      clearInterval(timer);
      timer = setInterval(() => {
        if (registration.installing || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
        void registration.update().catch(() => undefined);
      }, HOURLY);
    },
    onRegisterError: (error: unknown) => console.warn("Service worker registration failed", error),
  });
}

/** Reload: activate the waiting worker (the page reloads once it controls it), or just reload. */
export async function applyUpdate(): Promise<void> {
  requested = true;
  if (activated || !updateSW) return doReload();
  await updateSW();
}

/** Later: hide the panel until the next version. */
export function dismissSwUpdate(): void {
  setVisible(false);
}

export function __resetSwUpdateForTests(): void {
  clearInterval(timer);
  timer = undefined;
  updateSW = null;
  doReload = () => window.location.reload();
  requested = false;
  activated = false;
  view = { visible: false };
  listeners.clear();
}
