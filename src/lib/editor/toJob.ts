/**
 * Editor items -> `edit-pdf` wire job (camelCase, ids dropped, paint order kept). Images are read
 * only here: a JPEG the engine can embed as is goes through untouched, with its EXIF orientation
 * folded into the item rotation; anything else (or a mirrored EXIF orientation, which a rotation
 * cannot express) is decoded upright to RGBA. Freehand strokes are simplified.
 */
import {
  decodeToRgba,
  jpegPassthrough,
  orientationToTransform,
  readExifOrientation,
} from "../imageInput";
import { LIMITS, type Item, type Paint, type Point, type Rect, type Rgb, type Rotation, type StdFont, type TextAlign, type TextItem } from "./model";
import { SIMPLIFY_TOLERANCE, simplifyStroke } from "./simplify";

export type EditImageData =
  | { kind: "jpeg"; bytes: Uint8Array }
  | { kind: "rgba"; width: number; height: number; pixels: Uint8Array };

export type EditItemSpec =
  | ({
      kind: "text";
      page: number;
      rect: Rect;
      text: string;
      size: number;
      color: Rgb;
      opacity: number;
      align: TextAlign;
      lineHeight: number;
    } & (
      | { family?: "standard"; font: StdFont }
      /**
       * Embedded fonts: `faces` are font file names in chain order (family first), `fakeBold` the
       * faces drawn with synthetic bold. The worker attaches the files as the job's `fonts`.
       */
      | { family: "noto"; font: string; faces: string[]; fakeBold: string[] }
    ))
  | { kind: "image"; page: number; rect: Rect; image: EditImageData; opacity: number; rotation: Rotation }
  | { kind: "rect" | "ellipse"; page: number; rect: Rect; stroke: Paint; width: number; fill: Paint; opacity: number }
  | {
      kind: "line";
      page: number;
      from: Point;
      to: Point;
      color: Rgb;
      width: number;
      opacity: number;
      arrowStart: boolean;
      arrowEnd: boolean;
    }
  | { kind: "highlight"; page: number; rect: Rect; color: Rgb; opacity: number }
  | { kind: "freehand"; page: number; points: Point[]; color: Rgb; width: number; opacity: number }
  | { kind: "whiteout"; page: number; rect: Rect };

export interface EditJobSpec {
  items: EditItemSpec[];
  /** Font files of the job (`faces` of the text items), filled in by the worker. */
  fonts?: { id: string; bytes: Uint8Array }[];
}

/** How a text box is drawn: a standard font, or embedded fonts by file name. */
export type TextFontSpec = { family: "standard"; font: StdFont } | { family: "noto"; faces: string[]; fakeBold: string[] };

/** Chooses each text box's fonts (see `unicodeText.ts`); without one every box must use a standard font. */
export type TextFontResolver = (item: TextItem) => TextFontSpec;

/** Image reading, injectable for tests. */
export interface ImageReader {
  readBytes(blob: Blob): Promise<Uint8Array>;
  decodeRgba(blob: Blob): Promise<{ width: number; height: number; pixels: Uint8Array }>;
}

export const browserImageReader: ImageReader = {
  readBytes: async (blob) => new Uint8Array(await blob.arrayBuffer()),
  decodeRgba: (blob) => decodeToRgba(blob),
};

/** A picked image, read once: JPEG passthrough (with its EXIF rotation) or upright RGBA. */
type ReadImage = { image: EditImageData; exifRotate: Rotation };

async function readImage(blob: Blob, reader: ImageReader): Promise<ReadImage> {
  const bytes = await reader.readBytes(blob);
  if (jpegPassthrough(bytes)) {
    const exif = orientationToTransform(readExifOrientation(bytes));
    if (!exif.flipX) return { image: { kind: "jpeg", bytes }, exifRotate: exif.rotate };
  }
  const { width, height, pixels } = await reader.decodeRgba(blob);
  return { image: { kind: "rgba", width, height, pixels }, exifRotate: 0 };
}

/** Image payload and the total clockwise rotation the engine must apply to it. */
export async function readEditImage(
  blob: Blob,
  rotation: Rotation,
  reader: ImageReader = browserImageReader,
): Promise<{ image: EditImageData; rotation: Rotation }> {
  const { image, exifRotate } = await readImage(blob, reader);
  return { image, rotation: composeRotation(exifRotate, rotation) };
}

export function composeRotation(a: Rotation, b: Rotation): Rotation {
  return ((a + b) % 360) as Rotation;
}

/** Build the job for every item of the document (all pages), in paint order. */
export async function buildEditJob(
  items: readonly Item[],
  reader: ImageReader = browserImageReader,
  fonts?: TextFontResolver,
): Promise<EditJobSpec> {
  // The same picked file placed several times is read once and shares its buffer.
  const cache = new Map<Blob, Promise<ReadImage>>();
  const out: EditItemSpec[] = [];
  const raw = new Map<EditItemSpec, Point[]>();
  for (const item of items) {
    switch (item.kind) {
      case "text": {
        const { id: _id, font, ...rest } = item;
        const spec = fonts?.(item) ?? { family: "standard" as const, font: font as StdFont };
        out.push(spec.family === "standard" ? { ...rest, font: spec.font } : { ...rest, font, ...spec });
        break;
      }
      case "highlight":
      case "whiteout":
      case "line":
      case "rect":
      case "ellipse":
        out.push(withoutId(item));
        break;
      case "freehand": {
        const spec: EditItemSpec = { ...withoutId(item), points: simplifyStroke(item.points) };
        raw.set(spec, item.points);
        out.push(spec);
        break;
      }
      case "image": {
        let read = cache.get(item.image.blob);
        if (!read) {
          read = readImage(item.image.blob, reader);
          cache.set(item.image.blob, read);
        }
        const { image, exifRotate } = await read;
        out.push({
          kind: "image",
          page: item.page,
          rect: item.rect,
          image,
          opacity: item.opacity,
          rotation: composeRotation(exifRotate, item.rotation),
        });
        break;
      }
    }
  }
  return { items: fitFreehandBudget(out, raw) };
}

/**
 * Keep the job's freehand points within the engine budget (`LIMITS.freehandPoints` for all
 * strokes together): while over it, every stroke is simplified again from its original points
 * at 1, 2, 4 ... pt. Two points per stroke fit for any job within the item limit; past a
 * tolerance larger than any page (every stroke is then 2 points) it stops and the engine reports
 * the limit.
 */
function fitFreehandBudget(items: EditItemSpec[], raw: Map<EditItemSpec, Point[]>): EditItemSpec[] {
  const originals = items.map((it) => raw.get(it) ?? null);
  const total = (list: EditItemSpec[]) => list.reduce((n, it) => n + (it.kind === "freehand" ? it.points.length : 0), 0);
  let out = items;
  let tol = SIMPLIFY_TOLERANCE;
  while (total(out) > LIMITS.freehandPoints && tol < 2 * LIMITS.coord) {
    tol *= 2;
    const t = tol;
    out = out.map((it, i) => {
      const pts = originals[i];
      return it.kind === "freehand" && pts ? { ...it, points: simplifyStroke(pts, t) } : it;
    });
  }
  return out;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

function withoutId<T extends Item>(item: T): WithoutId<T> {
  const copy: Partial<T> = { ...item };
  delete copy.id;
  return copy as unknown as WithoutId<T>;
}

/** Distinct image buffers of a job, to transfer to the worker (a buffer listed twice throws). */
export function editJobTransferables(job: EditJobSpec): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  for (const it of job.items) {
    if (it.kind !== "image") continue;
    const data = it.image.kind === "jpeg" ? it.image.bytes : it.image.pixels;
    if (data.buffer instanceof ArrayBuffer) seen.add(data.buffer);
  }
  return [...seen];
}
