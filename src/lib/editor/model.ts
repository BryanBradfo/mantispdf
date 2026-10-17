/**
 * Edit PDF editor model. Items mirror the Rust `EditItem` kinds (crates/mantis-wasm/src/edit_ops)
 * in camelCase, plus an editor-only `id`. All geometry is in visible page space: points, origin
 * at the bottom-left of the page as displayed (CropBox, /Rotate applied), like the stamp engine.
 */
import type { StdFont } from "../stampJob";

export type { StdFont };

/** `[x, y]` in visible points. */
export type Point = [number, number];
/** `[x, y, w, h]` in visible points, `(x, y)` is the bottom-left corner. */
export type Rect = [number, number, number, number];
/** Colour channels in 0..1. */
export type Rgb = [number, number, number];
/** Stroke or fill paint of a rectangle or ellipse. */
export type Paint = { kind: "none" } | { kind: "rgb"; color: Rgb };
export type Align = "left" | "center" | "right";
export type Rotation = 0 | 90 | 180 | 270;

/**
 * The picked image file, read lazily when the job is built. `width`/`height` are the upright
 * (EXIF applied) pixel size, used for the aspect ratio of the placement.
 */
export interface ImageSource {
  blob: Blob;
  width: number;
  height: number;
}

interface Base {
  id: string;
  /** 1-based page number. */
  page: number;
}

export interface TextItem extends Base {
  kind: "text";
  rect: Rect;
  text: string;
  font: StdFont;
  size: number;
  color: Rgb;
  opacity: number;
  align: Align;
  lineHeight: number;
}

export interface ImageItem extends Base {
  kind: "image";
  rect: Rect;
  image: ImageSource;
  opacity: number;
  /** Clockwise quarter turns applied to the upright image. */
  rotation: Rotation;
}

export interface RectItem extends Base {
  kind: "rect";
  rect: Rect;
  stroke: Paint;
  width: number;
  fill: Paint;
  opacity: number;
}

export interface EllipseItem extends Base {
  kind: "ellipse";
  rect: Rect;
  stroke: Paint;
  width: number;
  fill: Paint;
  opacity: number;
}

export interface LineItem extends Base {
  kind: "line";
  from: Point;
  to: Point;
  color: Rgb;
  width: number;
  opacity: number;
  arrowStart: boolean;
  arrowEnd: boolean;
}

export interface HighlightItem extends Base {
  kind: "highlight";
  rect: Rect;
  color: Rgb;
  opacity: number;
}

export interface FreehandItem extends Base {
  kind: "freehand";
  points: Point[];
  color: Rgb;
  width: number;
  opacity: number;
}

export interface WhiteoutItem extends Base {
  kind: "whiteout";
  rect: Rect;
}

export type Item =
  | TextItem
  | ImageItem
  | RectItem
  | EllipseItem
  | LineItem
  | HighlightItem
  | FreehandItem
  | WhiteoutItem;

export type ItemKind = Item["kind"];
/** Items whose geometry is a `rect` field. */
export type RectBasedItem = Extract<Item, { rect: Rect }>;

/** Distributes `Omit` over the union so each kind keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An item before the reducer gives it an id. */
export type NewItem = DistributiveOmit<Item, "id">;

/** Partial props of one kind (never `id` or `kind`), merged by the `update` action. */
export type ItemPatch = {
  [K in ItemKind]: Partial<Omit<Extract<Item, { kind: K }>, "id" | "kind">>;
}[ItemKind];

export interface EditorState {
  /** Every page's items; array order is paint order (last on top). */
  items: Item[];
  selectedId: string | null;
  /** Snapshots of `items` before each committed change, oldest first, at most `HISTORY_LIMIT`. */
  past: Item[][];
  future: Item[][];
  /** 1-based page shown in the editor. */
  page: number;
  /** Next numeric id suffix (keeps the reducer pure). */
  nextId: number;
  /** `items` when the current pointer gesture started, null outside a gesture. */
  gestureBase: Item[] | null;
}

export const HISTORY_LIMIT = 100;

/**
 * Engine limits: mirror `crates/mantis-wasm/src/edit_ops/mod.rs` (MAX_ITEMS, MAX_FREEHAND_POINTS,
 * MAX_TEXT_CHARS, MAX_STROKE_WIDTH, MIN/MAX_FONT_SIZE, MIN/MAX_LINE_HEIGHT) and `stamp::engine`
 * MAX_COORD. `strokePoints` is the editor's own per-stroke cap (spec), not an engine check.
 */
export const LIMITS = {
  items: 2000,
  /** All freehand strokes of one job together. */
  freehandPoints: 20000,
  strokePoints: 5000,
  textChars: 5000,
  coord: 1e6,
  minWidth: 0,
  maxWidth: 100,
  minFontSize: 4,
  maxFontSize: 400,
  minLineHeight: 0.5,
  maxLineHeight: 5,
} as const;

export const NO_PAINT: Paint = { kind: "none" };
export const rgbPaint = (color: Rgb): Paint => ({ kind: "rgb", color });

export function initialEditorState(page = 1): EditorState {
  return { items: [], selectedId: null, past: [], future: [], page, nextId: 1, gestureBase: null };
}

export function isRectBased(item: Item): item is RectBasedItem {
  return "rect" in item;
}

export function itemsOnPage(items: readonly Item[], page: number): Item[] {
  return items.filter((it) => it.page === page);
}
