/**
 * Sizes for the page view's form controls, mirroring the engine's text appearance
 * (crates/mantis-wasm/src/forms/appearance.rs). The /DA font is not listed by the engine, so
 * automatic sizes use Helvetica metrics (the engine's fallback font).
 */
import { ascent, charUnits, descent } from "../editor/afm";
import type { Rect } from "../editor/model";
import { wrapLines } from "../editor/wrap";
import type { FieldKind, FormWidget } from "./model";

/** Inner padding of a text box, a comb cell, in points (`PADDING`, `COMB_PADDING`). */
export const PADDING = 2;
export const COMB_PADDING = 1;
/** Line spacing of a multiline field (`LEADING`). */
export const LEADING = 1.15;
const MIN_AUTO_SIZE = 4;
const MAX_AUTO_SIZE = 12;
const FONT = "Helvetica";

/**
 * A widget's visible box `[x, y, w, h]`, and the size of its content frame: the box itself, or
 * with its sides swapped when the content is turned a quarter.
 */
export function widgetFrame(w: FormWidget): { rect: Rect; width: number; height: number } {
  const [x0, y0, x1, y1] = w.rect;
  const rect: Rect = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
  const quarter = w.rotation === 90 || w.rotation === 270;
  return { rect, width: quarter ? rect[3] : rect[2], height: quarter ? rect[2] : rect[3] };
}

/** Width of `text` at size 1 (characters the fonts lack count 0, like the engine drops them). */
function unitWidth(text: string): number {
  let units = 0;
  for (const ch of text) units += charUnits(FONT, ch);
  return units / 1000;
}

/** The engine's automatic font size for a text field showing `text` in a `width` x `height` frame. */
export function autoFontSize(kind: FieldKind, text: string, width: number, height: number): number {
  const byHeight = height * 0.75;
  const floor = Math.min(MIN_AUTO_SIZE, byHeight);
  if (kind.kind === "text" && kind.comb && kind.maxLen !== null) {
    const cell = width / Math.max(1, kind.maxLen);
    let widest = 0;
    for (const ch of Array.from(text).slice(0, kind.maxLen)) widest = Math.max(widest, unitWidth(ch));
    const byWidth = widest > 0 ? (cell - 2 * COMB_PADDING) / widest : Infinity;
    return Math.max(Math.min(byHeight, byWidth), floor);
  }
  if (kind.kind === "text" && kind.multiline) {
    const avail = width - 2 * PADDING;
    for (let s = MAX_AUTO_SIZE; s >= MIN_AUTO_SIZE; s--) {
      const lines = wrapLines(text, FONT, s, avail).length;
      const needed = 2 * PADDING + ((ascent(FONT) - descent(FONT)) * s) / 1000 + Math.max(0, lines - 1) * s * LEADING;
      if (needed <= height) return s;
    }
    return MIN_AUTO_SIZE;
  }
  const unit = unitWidth(text);
  const byWidth = unit > 0 ? (width - 2 * PADDING) / unit : Infinity;
  return Math.max(Math.min(byHeight, byWidth), floor);
}

/** Font size (points) of a text-like control: the /DA size, or the automatic size for 0. */
export function textFontSize(kind: FieldKind, widget: FormWidget, text: string): number {
  if (widget.fontSize > 0) return widget.fontSize;
  const { width, height } = widgetFrame(widget);
  return autoFontSize(kind, text, width, height);
}
