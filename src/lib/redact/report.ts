/** The success report of a redaction, from the engine's counts. */
import type { RedactResultWire } from "./toJob";

/** What the engine guarantees: it verifies text, paths, shadings and images under the marks. */
export const REPORT_TITLE =
  "The marked content was removed and the result was checked: no text, images or drawings remain under the marks.";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The pages a search could not fully cover (undecodable or not searched), or null. */
export function uncoveredNote(undecodable: readonly number[], unsearched: readonly number[]): string | null {
  const pages = [...new Set([...undecodable, ...unsearched])].sort((a, b) => a - b);
  if (pages.length === 0) return null;
  return pages.length === 1
    ? `Search did not cover page ${pages[0]}; check it by hand.`
    : `Search did not cover pages ${pages.join(", ")}; check them by hand.`;
}

/** The lines of the success report: only what happened, plus the pages search did not cover. */
export function reportLines(r: RedactResultWire, uncovered: readonly number[] = []): string[] {
  const lines = [`${count(r.pagesRedacted.length, "page", "pages")} redacted.`];
  if (r.glyphsRemoved > 0) lines.push(`${count(r.glyphsRemoved, "character", "characters")} of text removed.`);
  if (r.imagesRedacted > 0) lines.push(`${count(r.imagesRedacted, "image", "images")} blacked out where marked.`);
  if (r.imagesRemoved > 0) lines.push(`${count(r.imagesRemoved, "image", "images")} removed entirely (could not be edited safely).`);
  if (r.pathsRemoved > 0) lines.push(`${count(r.pathsRemoved, "drawing", "drawings")} removed.`);
  if (r.formsRedacted > 0) lines.push(`${count(r.formsRedacted, "shared graphic (form XObject)", "shared graphics (form XObjects)")} redacted.`);
  if (r.annotationsRemoved > 0) lines.push(`${count(r.annotationsRemoved, "annotation or link", "annotations or links")} removed.`);
  for (const page of [...(r.widenedPages ?? [])].sort((a, b) => a - b)) lines.push(`Box widened to cover removed text on page ${page}`);
  if (r.pagesRasterized.length > 0) {
    lines.push(`Converted to images: ${r.pagesRasterized.length === 1 ? "page" : "pages"} ${r.pagesRasterized.join(", ")}.`);
  }
  const note = uncoveredNote(uncovered, []);
  if (note) lines.push(note);
  return lines;
}
