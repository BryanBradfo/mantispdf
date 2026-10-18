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
 * (EXIF applied) pixel size, used for the aspect ratio of the placement. `bytes` is what one
 * placement adds to the engine's image budget (`imagePayloadBytes`).
 */
export interface ImageSource {
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
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
  /**
   * Text box whose content is being typed. Set by the same `add` that creates a text box, so no
   * key typed right after the click can reach the editor shortcuts.
   */
  editingId: string | null;
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
  /** Rectangles and ellipses: 0 draws no outline. */
  minWidth: 0,
  /** Lines, arrows and drawings must stay visible (the engine refuses 0). */
  minStrokeWidth: 0.1,
  maxWidth: 100,
  minFontSize: 4,
  maxFontSize: 400,
  minLineHeight: 0.5,
  maxLineHeight: 5,
  /** Image items per job (`MAX_IMAGES`). */
  maxImages: 200,
  /**
   * Image data of a job (`MAX_IMAGE_BYTES`): JPEG bytes plus RGBA pixels, each distinct image
   * counted once (placements of one picked image share their data and their XObject).
   */
  maxImageBytes: 256 * 1024 * 1024,
} as const;

/** Kinds with a stroke `width`. */
export type StrokedKind = "rect" | "ellipse" | "line" | "freehand";

/** `width` clamped to what the engine accepts for `kind` (a non-number becomes the minimum). */
export function clampWidth(kind: StrokedKind, width: number): number {
  const min = kind === "line" || kind === "freehand" ? LIMITS.minStrokeWidth : LIMITS.minWidth;
  if (!Number.isFinite(width)) return min;
  return Math.min(LIMITS.maxWidth, Math.max(min, width));
}

/**
 * Bytes the engine receives for one placement of an image: the file itself when it is a JPEG
 * passed through as is, else its RGBA pixels (like `buildEditJob`).
 */
export function imagePayloadBytes(fileBytes: number, width: number, height: number, jpegPassthrough: boolean): number {
  return jpegPassthrough ? fileBytes : width * height * 4;
}

/**
 * Why `item` (a new item or a duplicate of an existing one) cannot be added to `items`: the item
 * limit, a box without area, or for an image the image budget. Null when it fits.
 */
export function addError(items: readonly Item[], item: NewItem | Item): string | null {
  if (items.length >= LIMITS.items) return `A document can hold at most ${LIMITS.items} edits.`;
  // Safety net: the engine rejects the whole job for one box without area.
  if ("rect" in item && !(item.rect[2] > 0 && item.rect[3] > 0)) return "This item has no area, so it was not added.";
  return item.kind === "image" ? imageBudgetError(items, item.image) : null;
}

/**
 * Why one more placement of `image` would exceed the engine's image budget, or null when it
 * fits. Every placement counts against the image limit (all pages); the bytes of one picked
 * image (one blob, which `buildEditJob` reads once) count once, like the engine.
 */
export function imageBudgetError(items: readonly Item[], image: ImageSource): string | null {
  let count = 1;
  const distinct = new Map<Blob, number>([[image.blob, image.bytes]]);
  for (const it of items) {
    if (it.kind !== "image") continue;
    count += 1;
    distinct.set(it.image.blob, it.image.bytes);
  }
  let bytes = 0;
  for (const b of distinct.values()) bytes += b;
  if (count > LIMITS.maxImages) return `A document can hold at most ${LIMITS.maxImages} images.`;
  if (bytes > LIMITS.maxImageBytes) return "Images can add up to at most 256 MB of image data per document.";
  return null;
}

export const NO_PAINT: Paint = { kind: "none" };
export const rgbPaint = (color: Rgb): Paint => ({ kind: "rgb", color });

export function initialEditorState(page = 1): EditorState {
  return { items: [], selectedId: null, editingId: null, past: [], future: [], page, nextId: 1, gestureBase: null };
}

export function isRectBased(item: Item): item is RectBasedItem {
  return "rect" in item;
}

export function itemsOnPage(items: readonly Item[], page: number): Item[] {
  return items.filter((it) => it.page === page);
}
