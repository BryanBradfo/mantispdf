import type { SanitizeReport } from "../hooks/usePdfWorker";
import type { NsT } from "../i18n";

/** User-facing explanation of the engine's page warnings. `warnings` counts
 * every page warning; `deepContentDropped` the ones where deeply nested
 * content was dropped. The rest are pages that kept all their resources. */
export function sanitizeWarnings(report: SanitizeReport, t: NsT<"sanitize">): string[] {
  const notes: string[] = [];
  if (report.warnings - report.deepContentDropped > 0) notes.push(t("notAnalysed"));
  if (report.deepContentDropped > 0) notes.push(t("deepDropped"));
  return notes;
}

/** "N images had their metadata removed" (Exif/GPS, XMP and the like in JPEG images), or null for none. */
export function imagesCleanedNote(report: SanitizeReport, t: NsT<"sanitize">): string | null {
  const n = report.imagesCleaned;
  return n > 0 ? t("imagesCleaned", { count: n }) : null;
}
