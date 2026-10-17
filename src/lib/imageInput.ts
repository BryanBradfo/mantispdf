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
      return parseExif(view, start, end);
    }
    i += 2 + len;
  }
  return 1;
}

function parseExif(view: DataView, start: number, end: number): Orientation {
  // "Exif\0\0" then a TIFF header.
  if (end - start < 14) return 1;
  const sig = [0x45, 0x78, 0x69, 0x66, 0, 0];
  for (let k = 0; k < 6; k++) if (view.getUint8(start + k) !== sig[k]) return 1;
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
    // SHORT, one value, stored inline.
    if (view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) < 1) return 1;
    const v = view.getUint16(entry + 8, little);
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

/** Browser only: decodes any browser-supported image to RGBA without applying EXIF rotation. */
export async function decodeToRgba(file: Blob): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "none" });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: bitmap.width,
      height: bitmap.height,
      pixels: new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength),
    };
  } finally {
    bitmap.close();
  }
}

/** Browser only: encodes RGBA pixels as a PNG. */
export async function rgbaToPngBlob(width: number, height: number, pixels: Uint8Array): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  const data = new ImageData(new Uint8ClampedArray(pixels), width, height);
  ctx.putImageData(data, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}
