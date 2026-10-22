/** Text box height that keeps every wrapped line (mirrors the clipping rule of `layoutText`). */
import type { StdFont } from "../stampJob";
import { ascent, charUnits, descent, unsupportedChars } from "./afm";
import type { EditFont, Rect } from "./model";
import { isNoto, metricFont } from "./unicodeText";
import { wrapLines } from "./wrap";

/** Height that shows `lines` lines: first ascent to last descender. */
export function textBoxHeight(lines: number, font: StdFont, size: number, lineHeight: number): number {
  const extra = Math.max(0, lines - 1);
  return ((ascent(font) - descent(font)) * size) / 1000 + extra * lineHeight * size;
}

/** Noto line metrics (em) taken generously: the CJK faces' ascender, Noto Sans' descender. */
const NOTO_ASCENT = 1.16;
const NOTO_DESCENT = 0.3;

/**
 * Lines a Noto text box needs, estimated before the engine lays it out: characters the standard
 * fonts cannot show count 1 em (CJK width, wide for other scripts), others their AFM width.
 */
function notoLines(text: string, font: StdFont, size: number, width: number): number {
  let lines = 0;
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let units = 0;
    for (const ch of paragraph) units += unsupportedChars(ch) === "" ? charUnits(font, ch) : 1000;
    lines += Math.max(1, Math.ceil((units * size) / 1000 / Math.max(width, 1e-6)));
  }
  return lines;
}

/** `rect` grown downwards (top edge fixed) when the wrapped text would lose lines, else `rect`. */
export function fitTextRect(rect: Rect, text: string, font: EditFont, size: number, lineHeight: number): Rect {
  const [x, y, w, h] = rect;
  const metric = metricFont(font);
  const needed =
    isNoto(font) || unsupportedChars(text) !== ""
      ? (NOTO_ASCENT + NOTO_DESCENT) * size + Math.max(0, notoLines(text, metric, size, w) - 1) * lineHeight * size
      : textBoxHeight(wrapLines(text, metric, size, w).length, metric, size, lineHeight);
  if (h >= needed) return rect;
  // A hair taller, so float rounding never drops the last line.
  const grown = needed + 1e-3;
  return [x, y + h - grown, w, grown];
}
