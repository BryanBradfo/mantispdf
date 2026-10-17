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
