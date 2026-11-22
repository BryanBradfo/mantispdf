/**
 * The desktop settings dialog (license + updates), opened from the home page's Pro button, the title
 * bar's gear and the update banner. One dialog for the whole app, mounted by App in Tauri only.
 */
export type SettingsSection = "license" | "updates";

export interface SettingsDialogState {
  open: boolean;
  /** Where focus lands when it opens. */
  section: SettingsSection;
}

let state: SettingsDialogState = { open: false, section: "license" };
const listeners = new Set<() => void>();

function set(next: SettingsDialogState) {
  state = next;
  for (const l of listeners) l();
}

export function getSettingsDialog(): SettingsDialogState {
  return state;
}

export function subscribeSettingsDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openSettings(section: SettingsSection = "license"): void {
  set({ open: true, section });
}

export function closeSettings(): void {
  if (state.open) set({ ...state, open: false });
}
