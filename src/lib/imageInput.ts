/** Browser-side image helpers: EXIF orientation, format sniffing, RGBA decode. */

export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Clockwise quarter turns in degrees, applied after the optional mirror. */
export interface OrientationTransform {
  rotate: 0 | 90 | 180 | 270;
  flipX: boolean;
}

/** One input of the images-to-PDF job (wire format of the worker op). */
export type ImageInputSpec = (
  | { kind: "jpeg"; bytes: Uint8Array }
  | { kind: "rgba"; width: number; height: number; pixels: Uint8Array }
) & { rotate: 0 | 90 | 180 | 270; flipX: boolean };

export interface ImageLayoutSpec {
  /** "fit" sizes each page to its image; otherwise [width, height] in points. */
  page: "fit" | [number, number];
  orientation: "auto" | "portrait" | "landscape";
  /** Points. */
  margin: number;
}

export type ExtractedImage = { page: number; index: number } & (
  | { kind: "jpeg"; bytes: Uint8Array }
  | { kind: "rgba"; width: number; height: number; pixels: Uint8Array }
);

export interface ExtractResultSpec {
  images: ExtractedImage[];
  skipped: { reason: string; count: number }[];
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** EXIF orientation (1..8) of a JPEG; 1 when absent, malformed or not a JPEG. */
export function readExifOrientation(bytes: Uint8Array): Orientation {
  if (!isJpeg(bytes)) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return 1;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Standalone markers have no length; a scan or end means no EXIF follows.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return 1;
    const len = view.getUint16(i + 2);
    if (len < 2) return 1;
    if (marker === 0xe1) {
      const start = i + 4;
      const end = Math.min(i + 2 + len, bytes.length);
      // Other APP1 segments (XMP) can precede the Exif one: keep scanning.
      if (hasExifSignature(view, start, end)) return parseExif(view, start, end);
    }
    i += 2 + len;
  }
  return 1;
}

function hasExifSignature(view: DataView, start: number, end: number): boolean {
  if (end - start < 14) return false;
  const sig = [0x45, 0x78, 0x69, 0x66, 0, 0];
  for (let k = 0; k < 6; k++) if (view.getUint8(start + k) !== sig[k]) return false;
  return true;
}

function parseExif(view: DataView, start: number, end: number): Orientation {
  const tiff = start + 6;
  const bom = view.getUint16(tiff);
  const little = bom === 0x4949;
  if (!little && bom !== 0x4d4d) return 1;
  if (view.getUint16(tiff + 2, little) !== 42) return 1;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd < tiff || ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    // SHORT (3) or LONG (4), one value, stored inline.
    const type = view.getUint16(entry + 2, little);
    if ((type !== 3 && type !== 4) || view.getUint32(entry + 4, little) < 1) return 1;
    const v = type === 3 ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little);
    return v >= 1 && v <= 8 ? (v as Orientation) : 1;
  }
  return 1;
}

/** The mirror (applied first) and clockwise rotation that display an image upright. */
export function orientationToTransform(o: Orientation): OrientationTransform {
  switch (o) {
    case 2:
      return { rotate: 0, flipX: true };
    case 3:
      return { rotate: 180, flipX: false };
    case 4:
      return { rotate: 180, flipX: true };
    case 5:
      return { rotate: 270, flipX: true };
    case 6:
      return { rotate: 90, flipX: false };
    case 7:
      return { rotate: 90, flipX: true };
    case 8:
      return { rotate: 270, flipX: false };
    default:
      return { rotate: 0, flipX: false };
  }
}

const MAX_DECODE_PIXELS = 100_000_000;

/** A budget check refused the image: its message is meant for the user as is. */
export class BudgetError extends Error {}

type Canvas2d = {
  width: number;
  height: number;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  toBlob: () => Promise<Blob>;
};

function makeCanvas(width: number, height: number): Canvas2d {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    return { width, height, ctx, toBlob: () => c.convertToBlob({ type: "image/png" }) };
  }
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    return {
      width,
      height,
      ctx,
      toBlob: () =>
        new Promise<Blob>((resolve, reject) =>
          c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"),
        ),
    };
  }
  throw new Error("Image decoding is not supported in this browser");
}

async function loadImage(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap !== "undefined") {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("Image decoding is not supported in this browser");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Browser only: decodes any browser-supported image to RGBA.
 *
 * Orientation contract: the browser applies the image's own orientation
 * (`from-image`), so the result is already upright and callers must NOT add an
 * EXIF transform for it. Our own EXIF parser is used only for JPEG passthrough
 * (original bytes embedded as-is), where the viewer needs the rotation.
 */
export async function decodeToRgba(
  file: Blob,
  /** Called with the size before the pixels are allocated; a returned message aborts the decode. */
  check?: (width: number, height: number) => string | null,
): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const image = await loadImage(file);
  try {
    const { width, height } = image;
    if (width < 1 || height < 1 || width * height > MAX_DECODE_PIXELS) {
      throw new Error("Image is too large to decode (limit 100 megapixels)");
    }
    const problem = check?.(width, height);
    if (problem) throw new BudgetError(problem);
    const canvas = makeCanvas(width, height);
    canvas.ctx.drawImage(image.source, 0, 0);
    const data = canvas.ctx.getImageData(0, 0, width, height);
    return { width, height, pixels: new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength) };
  } finally {
    image.close();
  }
}

/** Browser only: encodes RGBA pixels as a PNG. */
export async function rgbaToPngBlob(width: number, height: number, pixels: Uint8Array): Promise<Blob> {
  const canvas = makeCanvas(width, height);
  canvas.ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return canvas.toBlob();
}
