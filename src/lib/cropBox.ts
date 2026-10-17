import type { CropJobSpec, Rect } from "./geometryJob";

export type Size = [number, number];

/** A crop box handle: an edge (n, e, s, w) or a corner (ne, se, sw, nw), as seen on screen. */
export type Handle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Smallest crop box side, in points (the engine refuses under 1 pt). */
export const MIN_CROP_PT = 18;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Default crop box: the page with a 5% margin on each side. */
export function defaultCropRect([vw, vh]: Size): Rect {
  return [vw * 0.05, vh * 0.05, vw * 0.9, vh * 0.9];
}

/**
 * `rect` as it applies to `page`: its intersection with the page, like the engine computes it.
 * When that leaves less than `min` points on a side, the default box is used instead.
 */
export function fitCropToPage(rect: Rect, page: Size, min = MIN_CROP_PT): Rect {
  const [vw, vh] = page;
  const [x, y, w, h] = rect;
  const l = Math.max(0, x);
  const b = Math.max(0, y);
  const r = Math.min(vw, x + w);
  const t = Math.min(vh, y + h);
  if (!(r - l >= Math.min(min, vw) && t - b >= Math.min(min, vh))) return defaultCropRect(page);
  return [l, b, r - l, t - b];
}

/** Move `rect` by `dx`, `dy` points (y up), kept inside the page. */
export function moveCropRect(rect: Rect, dx: number, dy: number, [vw, vh]: Size): Rect {
  const [x, y, w, h] = rect;
  return [clamp(x + dx, 0, vw - w), clamp(y + dy, 0, vh - h), w, h];
}

/**
 * Drag one handle of `rect` by `dx`, `dy` points (y up): the edges it touches move, the others stay.
 * Edges stay on the page and the box never gets smaller than `min` points (or the page) on a side.
 */
export function resizeCropRect(rect: Rect, handle: Handle, dx: number, dy: number, page: Size, min = MIN_CROP_PT): Rect {
  const [vw, vh] = page;
  const [x, y, w, h] = rect;
  const minW = Math.min(min, vw);
  const minH = Math.min(min, vh);
  let l = x;
  let b = y;
  let r = x + w;
  let t = y + h;
  if (handle.includes("w")) l = clamp(l + dx, 0, r - minW);
  if (handle.includes("e")) r = clamp(r + dx, l + minW, vw);
  if (handle.includes("s")) b = clamp(b + dy, 0, t - minH);
  if (handle.includes("n")) t = clamp(t + dy, b + minH, vh);
  return [l, b, r - l, t - b];
}

/** Spoken description of the crop box, from the top-left of the page as it is shown. */
export function describeCrop(rect: Rect, page: Size): string {
  const [x, y, w, h] = rect;
  const r = Math.round;
  return `Crop area ${r(w)} by ${r(h)} pt, ${r(x)} pt from the left, ${r(page[1] - (y + h))} pt from the top.`;
}

export type CropScope = "this" | "all" | "range";

export interface CropChoice {
  scope: CropScope;
  /** Page shown in the preview (1-based); the target of scope "this". */
  page: number;
  /** Box for the shown page, already fitted to it. */
  rect: Rect;
  /** Pages of scope "range". */
  range: readonly number[];
  total: number;
  /** Per-page boxes from "Auto-detect margins" on all pages; when set, they replace scope and rect. */
  perPage: ReadonlyMap<number, Rect> | null;
  permanent: boolean;
}

/** The worker job for a crop choice. */
export function buildCropJob(c: CropChoice): CropJobSpec {
  if (c.perPage) {
    const perPage = [...c.perPage.entries()].sort(([a], [b]) => a - b).map(([page, rect]) => ({ page, rect }));
    return { pages: "all", perPage, permanent: c.permanent };
  }
  const pages = c.scope === "this" ? [c.page] : c.scope === "all" || c.range.length === c.total ? "all" : [...c.range];
  return { pages, rect: c.rect, permanent: c.permanent };
}
