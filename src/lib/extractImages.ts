import type { ExtractedImage } from "./imageInput";
import { rgbaToPngBlob } from "./imageInput";

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

const REASON_NAMES: Record<string, string> = {
  jpeg2000: "JPEG 2000",
  jbig2: "JBIG2",
  ccitt: "CCITT fax",
  "colour space": "unsupported colour space",
  corrupt: "corrupt",
  "too large": "too large",
  budget: "over the size budget",
  inline: "inline",
};

export function reasonName(reason: string): string {
  return REASON_NAMES[reason] ?? reason;
}

/** "3 images skipped: 2 JPEG 2000, 1 corrupt", or "" when nothing was skipped. */
export function skippedSummary(skipped: { reason: string; count: number }[]): string {
  const total = skipped.reduce((n, s) => n + s.count, 0);
  if (total === 0) return "";
  const parts = skipped.filter((s) => s.count > 0).map((s) => `${s.count} ${reasonName(s.reason)}`);
  return `${total} ${total === 1 ? "image" : "images"} skipped: ${parts.join(", ")}`;
}

/** Converts RGBA images to PNG blobs on demand, at most `limit` at a time, caching results. */
export class PngCache {
  private blobs = new Map<string, Promise<Blob>>();
  private urls = new Map<string, string>();
  private waiting: (() => void)[] = [];
  private active = 0;
  private disposed = false;

  constructor(private limit = 2) {}

  blob(img: Extract<ExtractedImage, { kind: "rgba" }>): Promise<Blob> {
    const key = imageKey(img);
    let p = this.blobs.get(key);
    if (!p) {
      p = this.schedule(() => rgbaToPngBlob(img.width, img.height, img.pixels));
      this.blobs.set(key, p);
    }
    return p;
  }

  async url(img: Extract<ExtractedImage, { kind: "rgba" }>): Promise<string | null> {
    const key = imageKey(img);
    const blob = await this.blob(img);
    if (this.disposed) return null;
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
          this.waiting.shift()?.();
        });
      };
      if (this.active < this.limit) start();
      else this.waiting.push(start);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.blobs.clear();
  }
}
