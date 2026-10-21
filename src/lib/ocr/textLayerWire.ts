/**
 * What `add_text_layer` (`crates/mantis-wasm/src/ocr/binding.rs`) reads: recognised words per
 * page, in visible-space points (origin bottom-left of the page as displayed). Keys in
 * `wireKeys.ts`.
 *
 * Engine limits (`Invalid OCR settings: <field>`): at most 2000 page entries, 200000 words per
 * page and 2000000 in all, each word's text at most 200 UTF-16 units, boxes at least 0.01 pt.
 */
export interface OcrWordWire {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The baseline's y, when the recogniser knows it (else 0.2 h above the box bottom). */
  baseline: number | null;
  /** The next word follows on the same line: a space is drawn up to its start. */
  spaceAfter: boolean;
  /**
   * A deskewed word: its baseline is turned this many degrees counter-clockwise about the box's
   * bottom-left corner `(x, y)`, and `w` x `h` (and `baseline`) are in the word's own frame.
   * Absent or null: upright.
   */
  angle?: number | null;
}

export interface OcrPageWire {
  /** 1-based page number. */
  page: number;
  words: OcrWordWire[];
}
