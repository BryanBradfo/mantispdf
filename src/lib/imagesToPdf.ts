import type { OrientationTransform } from "./imageInput";

export const MAX_IMAGES = 300;
export const MAX_MARGIN_MM = 200;

export type Quarter = 0 | 90 | 180 | 270;

/** Adds a clockwise user rotation to an EXIF transform (mirror first, then rotate). */
export function composeTransform(exif: OrientationTransform, userRotate: Quarter): OrientationTransform {
  return { rotate: (((exif.rotate + userRotate) % 360) as Quarter), flipX: exif.flipX };
}

/** The next user rotation after a quarter turn left (-1) or right (+1). */
export function turn(rotate: Quarter, dir: -1 | 1): Quarter {
  return ((((rotate + dir * 90) % 360) + 360) % 360) as Quarter;
}

/** Why the settings cannot be used, or null. */
export function imagesProblem(count: number, marginMm: number): string | null {
  if (count > MAX_IMAGES) return `Too many images: the limit is ${MAX_IMAGES} per PDF.`;
  if (!Number.isFinite(marginMm) || marginMm < 0 || marginMm > MAX_MARGIN_MM) {
    return `Margin must be between 0 and ${MAX_MARGIN_MM} mm.`;
  }
  return null;
}

export function layoutSummary(count: number, paperLabel: string, orientation: string, marginMm: number): string {
  const margin = Number.isFinite(marginMm) ? marginMm : 0;
  return `${count} image${count === 1 ? "" : "s"} · ${count} page${count === 1 ? "" : "s"} · ${paperLabel} · ${orientation} · margin ${margin} mm`;
}

/** Download name: `<name>.pdf` for one image, else `images.pdf`. */
export function imagesPdfName(names: string[]): string {
  if (names.length !== 1) return "images.pdf";
  const base = names[0].replace(/\.[^./\\]+$/, "");
  return `${base || "images"}.pdf`;
}

export const MAX_IMAGE_PIXELS = 100_000_000;
export const MAX_TOTAL_PIXELS = 400_000_000;

/** Error text if adding an image of this size breaks the pixel limits, else null. */
export function pixelBudgetProblem(name: string, width: number, height: number, usedSoFar: number): string | null {
  const px = width * height;
  if (px > MAX_IMAGE_PIXELS) return `${name} is too large (${width} x ${height}); the limit is 100 megapixels per image.`;
  if (usedSoFar + px > MAX_TOTAL_PIXELS) return `Adding ${name} exceeds the 400 megapixel total limit. Remove some images or use fewer large ones.`;
  return null;
}

const MAGIC: [string, number[]][] = [
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/bmp", [0x42, 0x4d]],
];

/** Sniffs an image type from leading bytes (for files with an empty MIME type); null if unknown. */
export function sniffImageType(head: Uint8Array): string | null {
  for (const [type, sig] of MAGIC) if (sig.every((b, i) => head[i] === b)) return type;
  const ascii = (a: number, n: number) => String.fromCharCode(...head.slice(a, a + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}
