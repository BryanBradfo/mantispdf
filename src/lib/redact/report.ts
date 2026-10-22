/** The success report of a redaction, from the engine's counts. */
import type { RedactResultWire } from "./toJob";
import type { NsT } from "../../i18n";

/** The pages a search could not fully cover (undecodable or not searched), or null. */
export function uncoveredNote(undecodable: readonly number[], unsearched: readonly number[], t: NsT<"redact">): string | null {
  const pages = [...new Set([...undecodable, ...unsearched])].sort((a, b) => a - b);
  if (pages.length === 0) return null;
  return t("uncovered", { count: pages.length, list: pages.join(", ") });
}

/** The lines of the success report: only what happened, plus the pages search did not cover. */
export function reportLines(r: RedactResultWire, uncovered: readonly number[], t: NsT<"redact">): string[] {
  const lines = [t("pagesRedacted", { count: r.pagesRedacted.length })];
  if (r.glyphsRemoved > 0) lines.push(t("glyphsRemoved", { count: r.glyphsRemoved }));
  if (r.imagesRedacted > 0) lines.push(t("imagesRedacted", { count: r.imagesRedacted }));
  if (r.pathsRemoved > 0) lines.push(t("pathsRemoved", { count: r.pathsRemoved }));
  if (r.formsRedacted > 0) lines.push(t("formsRedacted", { count: r.formsRedacted }));
  if (r.annotationsRemoved > 0) lines.push(t("annotationsRemoved", { count: r.annotationsRemoved }));
  for (const page of [...(r.widenedPages ?? [])].sort((a, b) => a - b)) lines.push(t("widened", { page }));
  if (r.pagesRasterized.length > 0) {
    const pages = t("pageList", { count: r.pagesRasterized.length, list: r.pagesRasterized.join(", ") });
    lines.push(t("rasterized", { pages }));
  }
  const note = uncoveredNote(uncovered, [], t);
  if (note) lines.push(note);
  return lines;
}

type ReasonKey = "reasonFont" | "reasonGraphics" | "reasonScanned" | "reasonLargeImage";

/** Plain words for the engine's reasons, first match wins (the detail stays available). */
const REASONS: [RegExp, ReasonKey][] = [
  [/type ?3/i, "reasonFont"],
  [/shaped clip path|soft mask|pattern/i, "reasonGraphics"],
  [/scanned image/i, "reasonScanned"],
  [/too large/i, "reasonLargeImage"],
];

/** Why a page has to become an image, in plain words. */
export function plainReason(reason: string, t: NsT<"redact">): string {
  const key = REASONS.find(([re]) => re.test(reason))?.[1];
  return key ? t(key) : t("reasonOther");
}

/** The reason given for pages the engine asks to rasterize only while redacting. */
export const TOO_LARGE_REASON = "image too large to edit in memory";

/**
 * The pages of the engine's late raster request ("Invalid redact settings: needs raster [2, 5]",
 * found while redacting, after the plan), ascending; null for any other message.
 */
export function neededRasters(message: string): number[] | null {
  const m = /Invalid redact settings: needs raster \[([\d,\s]+)\]/.exec(message);
  if (!m) return null;
  const pages = m[1].split(",").map((t) => Number(t.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return pages.length > 0 ? [...new Set(pages)].sort((a, b) => a - b) : null;
}
