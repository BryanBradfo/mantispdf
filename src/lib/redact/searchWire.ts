/**
 * What `redact_search` returns beyond `RedactSearchWire` (keys in `wireKeys.ts`). Rects are
 * visible-space `[x, y, w, h]`.
 */
import type { Rect } from "./model";
import type { RedactSearchWire } from "./toJob";

/** The page text around a match, as drawn: up to 20 characters each side (unknown text is U+FFFD). */
export interface SearchContextWire {
  before: string;
  text: string;
  after: string;
}

/** One match: one rect per line it spans, and its context. */
export interface SearchMatchWire {
  /** 1-based page. */
  page: number;
  rects: Rect[];
  context: SearchContextWire;
}

export interface RedactSearchResultWire extends RedactSearchWire {
  /** Every match, in page and reading order (the same rects as `pages[].quads`). */
  matches: SearchMatchWire[];
  /** Per page, boxes of glyphs whose text is unknown (each run on a line merged): search cannot see there. */
  unknownBoxes: { page: number; rects: Rect[] }[];
}
