/**
 * Pixel difference of two page renders of the same size (overlay view, spec 6a 1.4). Pure: runs in
 * the pixel worker (`src/workers/pixelDiff.worker.ts`) and in tests.
 */

/** A pixel differs when one of its channels moves by more than this (anti-aliasing noise stays under it). */
export const DIFF_THRESHOLD = 32;
/** Changed pixels are grown by this many pixels on each side so thin strokes stay visible. */
export const DIFF_DILATE = 2;

/** The parts of an ImageData the diff reads (RGBA, row-major). */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface PixelDiff {
  width: number;
  height: number;
  /** 1 where a pixel changed or lies within DIFF_DILATE of one (Chebyshev distance), else 0. */
  mask: Uint8Array;
  /** Pixels that really changed (before dilation). */
  changed: number;
  /** changed / (width x height); 0 for an empty image. */
  ratio: number;
}

function check(img: Pixels, name: string) {
  if (img.data.length !== img.width * img.height * 4) throw new Error(`pixelDiff: ${name} has ${img.data.length} bytes for ${img.width} x ${img.height}`);
}

/** Grow the mask by `r` pixels along one axis (running window max), in place via `tmp`. */
function dilateAxis(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number, horizontal: boolean) {
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const step = horizontal ? 1 : w;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w : line;
    // Distance to the last set pixel seen when scanning forward, then backward.
    let last = -Infinity;
    for (let i = 0; i < len; i++) {
      const k = base + i * step;
      if (src[k]) last = i;
      dst[k] = i - last <= r ? 1 : 0;
    }
    last = Infinity;
    for (let i = len - 1; i >= 0; i--) {
      const k = base + i * step;
      if (src[k]) last = i;
      if (last - i <= r) dst[k] = 1;
    }
  }
}

export function pixelDiff(a: Pixels, b: Pixels, threshold = DIFF_THRESHOLD, dilate = DIFF_DILATE): PixelDiff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`pixelDiff: images must be the same size (${a.width} x ${a.height} vs ${b.width} x ${b.height})`);
  }
  check(a, "first image");
  check(b, "second image");
  const { width: w, height: h } = a;
  const n = w * h;
  const raw = new Uint8Array(n);
  const da = a.data;
  const db = b.data;
  let changed = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (
      Math.abs(da[i] - db[i]) > threshold ||
      Math.abs(da[i + 1] - db[i + 1]) > threshold ||
      Math.abs(da[i + 2] - db[i + 2]) > threshold ||
      Math.abs(da[i + 3] - db[i + 3]) > threshold
    ) {
      raw[p] = 1;
      changed++;
    }
  }
  let mask = raw;
  if (changed > 0 && dilate > 0) {
    // Separable square dilation: rows then columns, O(n) whatever the radius.
    const tmp = new Uint8Array(n);
    mask = new Uint8Array(n);
    dilateAxis(raw, tmp, w, h, dilate, true);
    dilateAxis(tmp, mask, w, h, dilate, false);
  }
  return { width: w, height: h, mask, changed, ratio: n === 0 ? 0 : changed / n };
}

/** RGBA pixels for an overlay canvas: `rgba` where the mask is set, transparent elsewhere. */
export function paintMask(mask: Uint8Array, rgba: readonly [number, number, number, number]): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(mask.length * 4));
  const [r, g, b, al] = rgba;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (mask[p]) {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = al;
    }
  }
  return out;
}
