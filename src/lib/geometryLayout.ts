/** Pure layout math for the Resize and N-up mini-previews. Mirrors the Rust engine (geometry_ops). */
import type { NupJobSpec, Orientation, Rect, ResizeJobSpec } from "./geometryJob";

export type Size = [number, number];

/** Sheet size [w, h] for a portrait size, with `landscape` swapping the long side to the width. */
export function orient([w, h]: Size, landscape: boolean): Size {
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  return landscape ? [long, short] : [short, long];
}

/** Resize: target sheet and the scaled page rect on it (origin bottom-left). */
export function resizeLayout(
  page: Size,
  job: Pick<ResizeJobSpec, "size" | "orientation" | "mode" | "margin">,
): { sheet: Size; rect: Rect; scale: number } {
  const [vw, vh] = page;
  const landscape = job.orientation === "auto" ? vw > vh : job.orientation === "landscape";
  const [sw, sh] = orient(job.size, landscape);
  const fit = Math.min((sw - 2 * job.margin) / vw, (sh - 2 * job.margin) / vh);
  const scale = job.mode === "fit" ? fit : Math.min(fit, 1);
  return { sheet: [sw, sh], scale, rect: [(sw - scale * vw) / 2, (sh - scale * vh) / 2, scale * vw, scale * vh] };
}

/** (columns, rows) for `perSheet` on a portrait or landscape sheet. */
export function nupGrid(perSheet: NupJobSpec["perSheet"], landscape: boolean): [number, number] {
  const [c, r]: [number, number] =
    perSheet === 2 ? [1, 2]
    : perSheet === 4 ? [2, 2]
    : perSheet === 6 ? [2, 3]
    : perSheet === 8 ? [2, 4]
    : perSheet === 9 ? [3, 3]
    : [4, 4];
  return landscape ? [r, c] : [c, r];
}

export const autoLandscape = (perSheet: NupJobSpec["perSheet"]): boolean => perSheet === 2 || perSheet === 8;

/** Sheet size of an N-up job; `first` is the first page's visible size (used for "same"). */
export function nupSheetSize(
  job: Pick<NupJobSpec, "perSheet" | "sheet" | "orientation">,
  first: Size,
): Size {
  const base: Size = job.sheet === "same" ? first : job.sheet;
  const landscape = job.orientation === "auto" ? autoLandscape(job.perSheet) : job.orientation === "landscape";
  return orient(base, landscape);
}

/** Cell rects [x, y, w, h] in fill order, first at the top-left (origin bottom-left). Empty when no room. */
export function nupCells(
  perSheet: NupJobSpec["perSheet"],
  [w, h]: Size,
  order: NupJobSpec["order"],
  margin: number,
  gap: number,
): Rect[] {
  const [c, r] = nupGrid(perSheet, w > h);
  const cw = (w - 2 * margin - (c - 1) * gap) / c;
  const ch = (h - 2 * margin - (r - 1) * gap) / r;
  if (!(cw > 0 && ch > 0)) return [];
  return Array.from({ length: c * r }, (_, i) => {
    const col = order === "rows" ? i % c : Math.floor(i / r);
    const row = order === "rows" ? Math.floor(i / c) : i % r;
    const top = h - margin - row * (ch + gap);
    return [margin + col * (cw + gap), top - ch, cw, ch] as Rect;
  });
}

/** The page scaled to fit and centered in a cell. */
export function fitInCell(cell: Rect, [vw, vh]: Size): Rect {
  const [x, y, w, h] = cell;
  const s = Math.min(w / vw, h / vh);
  return [x + (w - s * vw) / 2, y + (h - s * vh) / 2, s * vw, s * vh];
}

export type { Orientation };
