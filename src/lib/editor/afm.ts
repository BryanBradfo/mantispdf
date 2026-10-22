/**
 * WinAnsi encoding and AFM widths of the standard fonts, a port of
 * crates/mantis-wasm/src/stamp/fonts.rs (same tables, same error message).
 */
import type { StdFont } from "../stampJob";
import { AFM_VMETRICS, AFM_WIDTHS } from "./afmWidths";
import { normalizeTypographicSpaces } from "../pdfText";

/** WinAnsi 0x80..0x9F: the characters that differ from Latin-1 (0x81, 0x8D, 0x8F, 0x90, 0x9D are undefined). */
const CP1252_HIGH: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** WinAnsi byte of one character (a code point), or null when the standard fonts cannot show it. */
export function winAnsiByte(ch: string): number | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return CP1252_HIGH.get(cp) ?? null;
}

/**
 * Characters of a text box the standard fonts cannot show, deduplicated, in order of first
 * appearance. `\r`, `\n` and `\t` are not reported: the engine checks the text with them replaced
 * by spaces (they break lines and words, they are never drawn).
 */
export function unsupportedChars(text: string): string {
  let bad = "";
  // Typographic spaces are saved as U+00A0 (`normalizeTypographicSpaces`), so they are fine.
  for (const ch of normalizeTypographicSpaces(text)) {
    if (ch === "\r" || ch === "\n" || ch === "\t") continue;
    if (winAnsiByte(ch) === null && !bad.includes(ch)) bad += ch;
  }
  return bad;
}

/** Message of the engine for unsupported characters (identical text). */
export function unsupportedMessage(bad: string): string {
  return `Characters not supported by the standard PDF fonts: ${bad}`;
}

/** Encode `text` as WinAnsi bytes; throws the engine's message listing every unsupported character. */
export function encodeWinAnsi(text: string): Uint8Array {
  const bytes: number[] = [];
  let bad = "";
  for (const ch of text) {
    const b = winAnsiByte(ch);
    if (b !== null) bytes.push(b);
    else if (!bad.includes(ch)) bad += ch;
  }
  if (bad !== "") throw new Error(unsupportedMessage(bad));
  return Uint8Array.from(bytes);
}

/** Width of WinAnsi `bytes` in integer AFM units (1/1000 em); bytes below 32 count as zero. */
export function textUnits(font: StdFont, bytes: ArrayLike<number>): number {
  const table = AFM_WIDTHS[font];
  let units = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 32) units += table[b - 32];
  }
  return units;
}

/** Width in points of WinAnsi `bytes` set in `font` at `size` (as `text_width` in Rust). */
export function textWidth(font: StdFont, bytes: ArrayLike<number>, size: number): number {
  return (textUnits(font, bytes) * size) / 1000;
}

/** AFM units of one character; 0 outside WinAnsi (callers validate the text first). */
export function charUnits(font: StdFont, ch: string): number {
  const b = winAnsiByte(ch);
  return b === null ? 0 : AFM_WIDTHS[font][b - 32];
}

/** Ascender per 1000 em. */
export function ascent(font: StdFont): number {
  return AFM_VMETRICS[font].ascender;
}

/** Descender per 1000 em (negative). */
export function descent(font: StdFont): number {
  return AFM_VMETRICS[font].descender;
}
