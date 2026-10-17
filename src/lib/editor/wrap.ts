/**
 * Text box wrapping and line placement, an exact port of `wrap_lines` and `layout_text` in
 * crates/mantis-wasm/src/edit_ops/text.rs. Both are checked against the shared vectors in
 * `wrapVectors.json` so the preview breaks lines exactly where the PDF will.
 */
import type { StdFont } from "../stampJob";
import { ascent, charUnits, descent, textWidth, winAnsiByte } from "./afm";
import type { Align, Rect } from "./model";

/**
 * Wraps `text` into lines no wider than `maxWidth` points.
 *
 * - `\r\n` and `\r` are line breaks like `\n`; each paragraph wraps on its own.
 * - Words are separated by runs of spaces or tabs; a line joins its words with one space;
 *   leading and trailing blanks are dropped.
 * - Greedy: a word goes on the current line when the joined line still fits
 *   (`width <= maxWidth`), else it starts a new line.
 * - A word wider than `maxWidth` is broken by characters (at least one character per line).
 * - An empty (or blank) paragraph is one empty line.
 * - Widths are integer AFM units times `size / 1000` (characters outside WinAnsi count as zero).
 */
export function wrapLines(text: string, font: StdFont, size: number, maxWidth: number): string[] {
  const fits = (u: number) => (u * size) / 1000 <= maxWidth;
  const space = charUnits(font, " ");
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines: string[] = [];
  for (const paragraph of normalized.split("\n")) {
    let current = "";
    let currentUnits = 0;
    let produced = false;
    for (const word of paragraph.split(/[ \t]/)) {
      if (word === "") continue;
      let wordUnits = 0;
      for (const ch of word) wordUnits += charUnits(font, ch);
      if (current !== "") {
        if (fits(currentUnits + space + wordUnits)) {
          current += " " + word;
          currentUnits += space + wordUnits;
          continue;
        }
        lines.push(current);
        current = "";
        currentUnits = 0;
        produced = true;
      }
      if (fits(wordUnits)) {
        current = word;
        currentUnits = wordUnits;
        continue;
      }
      // Hard break: as many characters per line as fit, at least one.
      for (const ch of word) {
        const u = charUnits(font, ch);
        if (current !== "" && !fits(currentUnits + u)) {
          lines.push(current);
          current = "";
          currentUnits = 0;
          produced = true;
        }
        current += ch;
        currentUnits += u;
      }
    }
    if (current !== "" || !produced) lines.push(current);
  }
  return lines;
}

/** One line placed in visible space: baseline origin and its text. */
export interface PlacedLine {
  x: number;
  y: number;
  text: string;
}

function lineBytes(line: string): number[] {
  const out: number[] = [];
  for (const ch of line) {
    const b = winAnsiByte(ch);
    if (b !== null) out.push(b);
  }
  return out;
}

/**
 * Lines of a text box laid out inside `rect` (visible space), like `layout_text`: the first
 * baseline sits `ascent * size / 1000` below the top, each next one `lineHeight * size` lower.
 * A line whose descender would go below the box bottom is dropped, except the first line, which
 * is always kept so text never vanishes silently. Empty lines are not returned (they still
 * advance). Unlike the engine it never throws: unsupported characters count as zero width (the
 * editor shows them with `unsupportedChars`).
 */
export function layoutText(
  rect: Rect,
  text: string,
  font: StdFont,
  size: number,
  align: Align,
  lineHeight: number,
): PlacedLine[] {
  const [x, y, w, h] = rect;
  const top = y + h;
  const first = top - (ascent(font) * size) / 1000;
  const desc = (descent(font) * size) / 1000;
  const out: PlacedLine[] = [];
  const lines = wrapLines(text, font, size, w);
  for (let i = 0; i < lines.length; i++) {
    const baseline = first - i * lineHeight * size;
    if (i > 0 && baseline + desc < y) break;
    const line = lines[i];
    if (line === "") continue;
    const lw = textWidth(font, lineBytes(line), size);
    const lx = align === "left" ? x : align === "center" ? x + (w - lw) / 2 : x + w - lw;
    out.push({ x: lx, y: baseline, text: line });
  }
  return out;
}
