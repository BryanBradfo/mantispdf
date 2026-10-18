/**
 * Sizes for the page view's form controls, mirroring the engine's text appearance
 * (crates/mantis-wasm/src/forms/appearance.rs), with the metrics of the font the engine draws
 * the widget with (`FormWidget.font`).
 */
import type { StdFont } from "../stampJob";
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
function unitWidth(text: string, font: StdFont): number {
  let units = 0;
  for (const ch of text) units += charUnits(font, ch);
  return units / 1000;
}

/** The engine's automatic font size for a text field showing `text` in a `width` x `height` frame. */
export function autoFontSize(kind: FieldKind, text: string, width: number, height: number, font: StdFont = "Helvetica"): number {
  const byHeight = height * 0.75;
  const floor = Math.min(MIN_AUTO_SIZE, byHeight);
  if (kind.kind === "text" && kind.comb && kind.maxLen !== null) {
    const cell = width / Math.max(1, kind.maxLen);
    let widest = 0;
    for (const ch of Array.from(text).slice(0, kind.maxLen)) widest = Math.max(widest, unitWidth(ch, font));
    const byWidth = widest > 0 ? (cell - 2 * COMB_PADDING) / widest : Infinity;
    return Math.max(Math.min(byHeight, byWidth), floor);
  }
  if (kind.kind === "text" && kind.multiline) {
    const avail = width - 2 * PADDING;
    for (let s = MAX_AUTO_SIZE; s >= MIN_AUTO_SIZE; s--) {
      const lines = wrapLines(text, font, s, avail).length;
      const needed = 2 * PADDING + ((ascent(font) - descent(font)) * s) / 1000 + Math.max(0, lines - 1) * s * LEADING;
      if (needed <= height) return s;
    }
    return MIN_AUTO_SIZE;
  }
  const unit = unitWidth(text, font);
  const byWidth = unit > 0 ? (width - 2 * PADDING) / unit : Infinity;
  return Math.max(Math.min(byHeight, byWidth), floor);
}

/** Font size (points) of a text-like control: the /DA size, or the automatic size for 0. */
export function textFontSize(kind: FieldKind, widget: FormWidget, text: string): number {
  if (widget.fontSize > 0) return widget.fontSize;
  const { width, height } = widgetFrame(widget);
  return autoFontSize(kind, text, width, height, widget.font);
}

/** Rounding slack, in points: a text exactly as wide as the box fits. */
const EPSILON = 1e-9;

/**
 * Whether the engine's appearance for `text` would be cut off by the widget box: a single line
 * wider than the box minus its padding (an automatic size only shrinks down to 4 pt), or more
 * wrapped lines than a multiline box is tall. Comb fields hold one character per cell and their
 * length is capped, so they never overflow here.
 */
export function overflows(kind: FieldKind, widget: FormWidget, text: string): boolean {
  if (kind.kind !== "text" && kind.kind !== "combo") return false;
  if (kind.kind === "text" && kind.comb && kind.maxLen !== null) return false;
  if (text === "") return false;
  const { width, height } = widgetFrame(widget);
  const size = textFontSize(kind, widget, text);
  const font = widget.font;
  if (kind.kind === "text" && kind.multiline) {
    const lines = wrapLines(text, font, size, width - 2 * PADDING).length;
    const needed = 2 * PADDING + ((ascent(font) - descent(font)) * size) / 1000 + Math.max(0, lines - 1) * size * LEADING;
    return needed > height + EPSILON;
  }
  return unitWidth(text, font) * size > width - 2 * PADDING + EPSILON;
}
