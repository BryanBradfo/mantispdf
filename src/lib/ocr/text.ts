/**
 * Page text helpers: whether pdf.js already finds text on a page (OCR may skip it), and the
 * plain-text export of recognised pages.
 */

/** A page has text when its pdf.js text content holds more than this many non-blank characters. */
export const HAS_TEXT_MIN_CHARS = 20;

/** pdf.js `getTextContent().items`: text items carry `str`, marked-content items do not. */
export type TextContentItem = { str: string } | { type: string };

export function hasText(items: readonly TextContentItem[]): boolean {
  let count = 0;
  for (const item of items) {
    if (!("str" in item)) continue;
    count += item.str.replace(/\s/g, "").length;
    if (count > HAS_TEXT_MIN_CHARS) return true;
  }
  return false;
}

/**
 * The .txt export: each page headed by a `--- Page N ---` line, pages separated by form feeds.
 * Each page's text ends with exactly one newline (none when it is empty).
 */
export function exportText(pages: readonly { page: number; text: string }[]): string {
  return pages
    .map(({ page, text }) => {
      const body = text.replace(/\s+$/, "");
      return `--- Page ${page} ---\n${body ? `${body}\n` : ""}`;
    })
    .join("\f");
}
