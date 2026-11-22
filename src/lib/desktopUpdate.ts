/**
 * Desktop automatic updates (Tauri updater + process plugins). Load this module ONLY through a dynamic
 * `import()` behind `isTauri()`: the web bundle must never carry the plugins.
 *
 * A tiny store the banner reads with `useSyncExternalStore`: the checks (5 s after launch, then every
 * 6 h, while the setting is on) fill it, "Later" hides it until the next launch, and `installUpdate`
 * downloads the signed bundle, reporting progress, then relaunches the app.
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { readAutoCheck } from "./updatePrefs";

export const FIRST_CHECK_DELAY_MS = 5_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateView {
  /** The version offered, null when there is none. */
  version: string | null;
  /** First line of the release notes, if any. */
  notes: string | null;
  /** The banner is shown: an update exists and "Later" was not chosen. */
  visible: boolean;
  /** `restartRequired`: installed, but the relaunch failed; the person restarts the app themselves. */
  phase: "idle" | "downloading" | "restarting" | "restartRequired";
  downloaded: number;
  /** Download size, null while unknown. */
  total: number | null;
  /** Why the last install failed (null when it did not). */
  error: unknown;
  /** Why the last background check failed (null once a check succeeds). Shown in the settings only. */
  lastAutoError: unknown;
}

const EMPTY: UpdateView = {
  version: null,
  notes: null,
  visible: false,
  phase: "idle",
  downloaded: 0,
  total: null,
  error: null,
  lastAutoError: null,
};

let view: UpdateView = EMPTY;
let pending: Update | null = null;
let dismissed = false;
let inFlight: Promise<Update | null> | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateView>) {
  view = { ...view, ...patch };
  view.visible = view.version !== null && !dismissed;
  for (const l of listeners) l();
}

export function getUpdateView(): UpdateView {
  return view;
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Percent downloaded (0-100), or null while the size is unknown. */
export function progressPercent(v: UpdateView): number | null {
  if (v.total === null || v.total <= 0) return null;
  return Math.min(100, Math.round((v.downloaded / v.total) * 100));
}

/** The first non-empty line of release notes, without markdown heading or list marks. */
export function firstNotesLine(body: string | undefined): string | null {
  const line = (body ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*]\s+)/, "").trim())
    .find((l) => l.length > 0);
  return line ?? null;
}

/** One request to the update endpoint at a time; a running install is never replaced. */
async function runCheck(): Promise<Update | null> {
  if (view.phase !== "idle") return pending;
  inFlight ??= check().finally(() => {
    inFlight = null;
  });
  const found = await inFlight;
  if (view.phase !== "idle") return pending;
  if (pending && pending !== found) void pending.close().catch(() => {});
  pending = found;
  set(
    found
      ? { version: found.version, notes: firstNotesLine(found.body), error: null, lastAutoError: null }
      : { version: null, notes: null, error: null, lastAutoError: null },
  );
  return found;
}

/** The "Check now" button: shows the banner again even after "Later". Throws when the check fails. */
export async function checkNow(): Promise<"available" | "latest"> {
  dismissed = false;
  const found = await runCheck();
  return found ? "available" : "latest";
}

/** A background check: skipped when the setting is off, silent on failure (offline included). */
async function autoCheck(): Promise<void> {
  if (!readAutoCheck()) return;
  try {
    await runCheck();
  } catch (e) {
    // Offline, or the release endpoint is unreachable: no banner, the next check tries again. The
    // settings show it, and the console keeps it for a bug report.
    console.warn(e);
    set({ lastAutoError: e });
  }
}

/** Starts the background checks; returns the function that stops them. */
export function startAutoChecks(
  delayMs: number = FIRST_CHECK_DELAY_MS,
  intervalMs: number = CHECK_INTERVAL_MS,
): () => void {
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    void autoCheck();
    interval = setInterval(() => void autoCheck(), intervalMs);
  }, delayMs);
  return () => {
    clearTimeout(first);
    if (interval !== undefined) clearInterval(interval);
  };
}

/** "Later": hidden until the next launch (or an explicit "Check now"). */
export function dismissUpdate(): void {
  dismissed = true;
  set({});
}

/**
 * Downloads and installs the offered update, then relaunches. Never throws: a failed download or
 * install lands in `error` (retry possible), a failed relaunch in `restartRequired`.
 */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update || view.phase !== "idle") return;
  set({ phase: "downloading", downloaded: 0, total: null, error: null });
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") set({ downloaded: 0, total: event.data.contentLength ?? null });
      else if (event.event === "Progress") set({ downloaded: view.downloaded + event.data.chunkLength });
    });
  } catch (e) {
    set({ phase: "idle", error: e });
    return;
  }
  // Installed: a failed relaunch must not offer to install again.
  set({ phase: "restarting" });
  try {
    await relaunch();
  } catch (e) {
    console.warn(e);
    set({ phase: "restartRequired" });
  }
}

/** Test-only: forget every check and choice. */
export function __resetUpdateForTests(): void {
  view = EMPTY;
  pending = null;
  dismissed = false;
  inFlight = null;
  listeners.clear();
}
