/** Wire types for the crop, resize and n-up worker operations (mirror the Rust jobs). */

/** Visible-space rectangle [x, y, width, height] in points, origin bottom-left. */
export type Rect = [number, number, number, number];

export type Orientation = "auto" | "portrait" | "landscape";

export interface CropJobSpec {
  pages: number[] | "all";
  /** Applied to every page in `pages`. */
  rect?: Rect;
  /** Overrides `rect` for the listed pages (1-based). */
  perPage?: { page: number; rect: Rect }[];
  /** Also shrink the MediaBox, for viewers that ignore the CropBox. */
  permanent?: boolean;
}

export interface ResizeJobSpec {
  pages: number[] | "all";
  /** Target sheet [width, height] in points, portrait. */
  size: [number, number];
  orientation: Orientation;
  mode: "fit" | "extend";
  /** Points. */
  margin: number;
}

export interface NupJobSpec {
  perSheet: 2 | 4 | 6 | 8 | 9 | 16;
  /** Sheet [width, height] in points, or the first page's size. */
  sheet: [number, number] | "same";
  orientation: Orientation;
  order: "rows" | "columns";
  /** Points. */
  margin: number;
  /** Points. */
  gap: number;
  border: boolean;
}

/** Portrait sizes in points. */
export const PAPER_SIZES = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
} as const satisfies Record<string, readonly [number, number]>;

export type PaperName = keyof typeof PAPER_SIZES;

const PT_PER_IN = 72;
const MM_PER_IN = 25.4;

export const mmToPt = (mm: number): number => (mm * PT_PER_IN) / MM_PER_IN;
export const ptToMm = (pt: number): number => (pt * MM_PER_IN) / PT_PER_IN;
export const inToPt = (inches: number): number => inches * PT_PER_IN;
export const ptToIn = (pt: number): number => pt / PT_PER_IN;
