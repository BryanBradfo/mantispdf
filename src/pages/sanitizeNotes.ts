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
