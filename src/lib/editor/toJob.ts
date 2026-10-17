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
import type { Align, Item, Paint, Point, Rect, Rgb, Rotation, StdFont } from "./model";
import { simplifyStroke } from "./simplify";

export type EditImageData =
  | { kind: "jpeg"; bytes: Uint8Array }
  | { kind: "rgba"; width: number; height: number; pixels: Uint8Array };

export type EditItemSpec =
  | {
      kind: "text";
      page: number;
      rect: Rect;
      text: string;
      font: StdFont;
      size: number;
      color: Rgb;
      opacity: number;
      align: Align;
      lineHeight: number;
    }
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
}

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
export async function buildEditJob(items: readonly Item[], reader: ImageReader = browserImageReader): Promise<EditJobSpec> {
  // The same picked file placed several times is read once and shares its buffer.
  const cache = new Map<Blob, Promise<ReadImage>>();
  const out: EditItemSpec[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "text":
      case "highlight":
      case "whiteout":
      case "line":
      case "rect":
      case "ellipse":
        out.push(withoutId(item));
        break;
      case "freehand":
        out.push({ ...withoutId(item), points: simplifyStroke(item.points) });
        break;
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
  return { items: out };
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
