/**
 * The "decoding" title effect: characters cycle through terminal glyphs, then settle left to right
 * on the final text. Pure helpers here; `DecodeText` drives them with a timer.
 */

/** Glyphs an unsettled character shows: uppercase A-Z, digits and a few terminal symbols. */
export const DECODE_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_#*+";

/** One frame every 30 ms. */
export const DECODE_FRAME_MS = 30;

/** Total run time for a text: 30 ms per character, kept within 400-600 ms. */
export function decodeDuration(text: string): number {
  return Math.min(600, Math.max(400, Array.from(text).length * DECODE_FRAME_MS));
}

/**
 * The text at `progress` (0..1): the first `progress * length` characters are final, the others are
 * random glyphs from `rand` (in [0, 1)); whitespace (spaces, no-break spaces) never moves. Works on
 * code points, so accents and typographic apostrophes stay whole. At 1 it returns `text` itself.
 */
export function scrambleFrame(text: string, progress: number, rand: () => number): string {
  if (progress >= 1) return text;
  const chars = Array.from(text);
  const settled = Math.floor(Math.max(0, progress) * chars.length);
  return chars
    .map((ch, i) => {
      if (i < settled || /\s/.test(ch)) return ch;
      return DECODE_GLYPHS[Math.min(DECODE_GLYPHS.length - 1, Math.floor(rand() * DECODE_GLYPHS.length))];
    })
    .join("");
}
