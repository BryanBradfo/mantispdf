import type { ExtractedImage } from "./imageInput";
import { rgbaToPngBlob } from "./imageInput";
import type { NsT } from "../i18n";

export const MIN_IMAGE_SIDE = 32;

export function imageKey(img: ExtractedImage): string {
  return `${img.page}:${img.index}`;
}

export function imageExt(img: ExtractedImage): "jpg" | "png" {
  return img.kind === "jpeg" ? "jpg" : "png";
}

export function imageFileName(img: ExtractedImage): string {
  return `page${img.page}_img${img.index}.${imageExt(img)}`;
}

/** Pixel size when known without decoding; JPEG sizes are read from the SOF marker. */
export function imageSize(img: ExtractedImage): { width: number; height: number } | null {
  if (img.kind === "rgba") return { width: img.width, height: img.height };
  return jpegSize(img.bytes);
}

export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Drops images whose known sides are both below `min`; unknown sizes are kept. */
export function filterImages(images: ExtractedImage[], skipSmall: boolean, min = MIN_IMAGE_SIDE): ExtractedImage[] {
  if (!skipSmall) return images;
  return images.filter((img) => {
    const s = imageSize(img);
    return !s || s.width >= min || s.height >= min;
  });
}

/** Engine skip reasons and their `extractImages` key. */
const REASON_KEYS = {
  jpeg2000: "reasonJpeg2000",
  jbig2: "reasonJbig2",
  ccitt: "reasonCcitt",
  "colour space": "reasonColourSpace",
  corrupt: "reasonCorrupt",
  "too large": "reasonTooLarge",
  budget: "reasonBudget",
  "alpha dropped": "reasonAlphaDropped",
  inline: "reasonInline",
} as const;

export function reasonName(reason: string, t: NsT<"extractImages">): string {
  return Object.prototype.hasOwnProperty.call(REASON_KEYS, reason) ? t(REASON_KEYS[reason as keyof typeof REASON_KEYS]) : reason;
}

/** The engine lists these with the skipped reasons, but the images themselves were extracted (opaque). */
const ALPHA_DROPPED = "alpha dropped";

/** "3 images skipped: 2 JPEG 2000, 1 corrupt", or "" when nothing was skipped. */
export function skippedSummary(skipped: { reason: string; count: number }[], t: NsT<"extractImages">): string {
  const real = skipped.filter((s) => s.count > 0 && s.reason !== ALPHA_DROPPED);
  const total = real.reduce((n, s) => n + s.count, 0);
  if (total === 0) return "";
  const parts = real.map((s) => t("skippedItem", { count: s.count, reason: reasonName(s.reason, t) }));
  return t("skippedSummary", { count: total, list: parts.join(", ") });
}

/** "2 images kept without transparency", or "" when every mask was usable. */
export function keptWithoutAlphaSummary(skipped: { reason: string; count: number }[], t: NsT<"extractImages">): string {
  const n = skipped.filter((s) => s.reason === ALPHA_DROPPED).reduce((sum, s) => sum + s.count, 0);
  if (n === 0) return "";
  return t("keptSummary", { count: n });
}

type RgbaImage = Extract<ExtractedImage, { kind: "rgba" }>;

export interface PngCacheOptions {
  limit?: number;
  convert?: (width: number, height: number, pixels: Uint8Array) => Promise<Blob>;
  /** Called once an image's PNG blob exists, so callers can drop the pixel buffer. */
  onConverted?: (key: string) => void;
}

/** Converts RGBA images to PNG blobs on demand, at most `limit` at a time, caching results. */
export class PngCache {
  private blobs = new Map<string, Promise<Blob>>();
  private urls = new Map<string, string>();
  private waiting: { start: () => void; cancel: () => void }[] = [];
  private active = 0;
  private closed = false;
  private limit: number;
  private convert: NonNullable<PngCacheOptions["convert"]>;
  private onConverted?: (key: string) => void;

  constructor(opts: PngCacheOptions = {}) {
    this.limit = opts.limit ?? 2;
    this.convert = opts.convert ?? rgbaToPngBlob;
    this.onConverted = opts.onConverted;
  }

  get disposed(): boolean {
    return this.closed;
  }

  blob(img: RgbaImage): Promise<Blob> {
    if (this.closed) return Promise.reject(new Error("Cancelled"));
    const key = imageKey(img);
    let p = this.blobs.get(key);
    if (!p) {
      p = this.schedule(() => this.convert(img.width, img.height, img.pixels)).then((b) => {
        if (!this.closed) this.onConverted?.(key);
        return b;
      });
      this.blobs.set(key, p);
    }
    return p;
  }

  async url(img: RgbaImage): Promise<string | null> {
    const key = imageKey(img);
    const blob = await this.blob(img);
    if (this.closed) return null;
    let url = this.urls.get(key);
    if (!url) {
      url = URL.createObjectURL(blob);
      this.urls.set(key, url);
    }
    return url;
  }

  private schedule<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        job().then(resolve, reject).finally(() => {
          this.active--;
          this.waiting.shift()?.start();
        });
      };
      if (this.active < this.limit) start();
      else this.waiting.push({ start, cancel: () => reject(new Error("Cancelled")) });
    });
  }

  /** Revokes URLs and rejects every queued conversion; later requests are rejected too. */
  dispose(): void {
    this.closed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    const queued = this.waiting;
    this.waiting = [];
    for (const w of queued) w.cancel();
    // Cancelled queue entries are expected to reject; mark them handled.
    for (const p of this.blobs.values()) p.catch(() => undefined);
    this.blobs.clear();
  }
}
