import type { SanitizeReport } from "../hooks/usePdfWorker";

/** User-facing explanation of the engine's page warnings. `warnings` counts
 * every page warning; `deepContentDropped` the ones where deeply nested
 * content was dropped. The rest are pages that kept all their resources. */
export function sanitizeWarnings(report: SanitizeReport): string[] {
  const notes: string[] = [];
  if (report.warnings - report.deepContentDropped > 0) {
    notes.push("Some pages could not be fully analysed and kept all their resources.");
  }
  if (report.deepContentDropped > 0) {
    notes.push("Some deeply nested content could not be copied.");
  }
  return notes;
}

/** "N images had their metadata removed" (Exif/GPS, XMP and the like in JPEG images), or null for none. */
export function imagesCleanedNote(report: SanitizeReport): string | null {
  const n = report.imagesCleaned;
  if (n <= 0) return null;
  return n === 1 ? "1 image had its metadata removed" : `${n} images had their metadata removed`;
}
