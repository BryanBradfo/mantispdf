/**
 * Text for the standard PDF fonts (WinAnsi). macOS and iOS French typing inserts a narrow no-break
 * space (U+202F) before ! ? ; : and some tools a thin space (U+2009); neither is in WinAnsi, so the
 * engine would refuse the text. Both become U+00A0, which is, before any text goes to the engine.
 */
export function normalizeTypographicSpaces(text: string): string {
  return text.replace(/[\u202F\u2009]/g, "\u00a0");
}
