import type { OrientationTransform } from "./imageInput";

/**
 * Engine budgets, mirroring crates/mantis-wasm/src/images/to_pdf.rs (a unit
 * test reads the Rust source and keeps the two in step). Checked here before
 * and while files are read, so a job the engine would refuse fails early with
 * the file's name instead of after every image is decoded.
 */
export const MAX_IMAGES = 300;
/** Most pixels in one image (a decoded image or a JPEG frame). */
export const MAX_IMAGE_PIXELS = 100_000_000;
/** Most input bytes in one job: JPEG files plus 4 bytes per decoded pixel. */
export const MAX_INPUT_BYTES = 512 * 1024 * 1024;
export const MAX_MARGIN_MM = 200;

const MIB = 1024 * 1024;

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

/** Error text if one image has more pixels than the per-image limit, else null. */
export function pixelBudgetProblem(name: string, width: number, height: number): string | null {
  if (width * height > MAX_IMAGE_PIXELS) {
    return `${name} is too large (${width} x ${height}); the limit is ${MAX_IMAGE_PIXELS / 1_000_000} megapixels per image.`;
  }
  return null;
}

/** Error text if `bytes` more input (file bytes for a JPEG, 4 per pixel otherwise) breaks the job budget, else null. */
export function inputBytesProblem(name: string, bytes: number, usedSoFar: number): string | null {
  if (usedSoFar + bytes <= MAX_INPUT_BYTES) return null;
  return `Adding ${name} brings the images to ${Math.ceil((usedSoFar + bytes) / MIB)} MB; the limit is ${MAX_INPUT_BYTES / MIB} MB per PDF (images other than JPEG count at 4 bytes per pixel). Remove some images or make several PDFs.`;
}

/** Checked before any file is read: the files alone must fit the input budget. */
export function totalSizeProblem(files: { name: string; size: number }[]): string | null {
  let used = 0;
  for (const f of files) {
    const problem = inputBytesProblem(f.name, f.size, used);
    if (problem) return problem;
    used += f.size;
  }
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
