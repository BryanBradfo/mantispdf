/** Text box height that keeps every wrapped line (mirrors the clipping rule of `layoutText`). */
import type { StdFont } from "../stampJob";
import { ascent, descent } from "./afm";
import type { Rect } from "./model";
import { wrapLines } from "./wrap";

/** Height that shows `lines` lines: first ascent to last descender. */
export function textBoxHeight(lines: number, font: StdFont, size: number, lineHeight: number): number {
  const extra = Math.max(0, lines - 1);
  return ((ascent(font) - descent(font)) * size) / 1000 + extra * lineHeight * size;
}

/** `rect` grown downwards (top edge fixed) when the wrapped text would lose lines, else `rect`. */
export function fitTextRect(rect: Rect, text: string, font: StdFont, size: number, lineHeight: number): Rect {
  const [x, y, w, h] = rect;
  const needed = textBoxHeight(wrapLines(text, font, size, w).length, font, size, lineHeight);
  if (h >= needed) return rect;
  // A hair taller, so float rounding never drops the last line.
  const grown = needed + 1e-3;
  return [x, y + h - grown, w, grown];
}
