/**
 * The desktop "Check for updates automatically" setting (on by default). Kept apart from
 * `desktopUpdate.ts` so the settings can read it without loading the updater plugin.
 */
export const AUTO_CHECK_KEY = "mantispdf.autoUpdateCheck";

export function readAutoCheck(): boolean {
  try {
    return localStorage.getItem(AUTO_CHECK_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeAutoCheck(on: boolean): void {
  try {
    localStorage.setItem(AUTO_CHECK_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the choice lasts until the app closes.
  }
}
