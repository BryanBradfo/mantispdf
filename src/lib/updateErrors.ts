/**
 * Updater errors (tauri-plugin-updater 2.12, src/error.rs) that mean this install cannot update itself:
 * the release has no signed bundle for its platform or package type (a .deb or .rpm when only the
 * AppImage is signed), the package is of another kind, or the system installer refused it. The person
 * then updates from the download page instead.
 */
const MANUAL_UPDATE: readonly RegExp[] = [
  /None of the fallback platforms .* were found in the response `platforms` object/,
  /the platform `.*` was not found in the response `platforms` object/,
  /invalid updater binary format/,
  /Failed to install (\.deb )?package/,
  /Unsupported (OS|application architecture)/,
  /binary for the current target not found in the archive/,
];

export function needsManualUpdate(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return MANUAL_UPDATE.some((p) => p.test(text));
}
