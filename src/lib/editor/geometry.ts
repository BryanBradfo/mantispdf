/**
 * Editor geometry in visible page space (points, origin bottom-left), plus the mapping to and from
 * the preview (CSS pixels, origin top-left). Rect mapping is the one Sign and Crop use
 * (`src/lib/signPlacement.ts`); points follow the same convention.
 */
import { previewToVisibleRect, visibleToPreviewRect, type PreviewBox, type Size } from "../signPlacement";
import type { Item, Point, Rect } from "./model";

export { previewToVisibleRect, visibleToPreviewRect };
export type { PreviewBox, Size };

/** Smallest width or height a resize produces, in points. */
export const MIN_SIZE = 1;
/** Default hit slop in points (lines and strokes are hit within max(slop, width)). */
export const HIT_SLOP = 4;

/** Preview pixel `[left, top]` to a visible point. `visibleSize` is the displayed (rotated) size. */
export function previewToVisiblePoint(p: Point, previewSize: Size, visibleSize: Size): Point {
  const [pw, ph] = previewSize;
  const [vw, vh] = visibleSize;
  return [(p[0] * vw) / pw, ((ph - p[1]) * vh) / ph];
}

/** Inverse of `previewToVisiblePoint`. */
export function visibleToPreviewPoint(p: Point, previewSize: Size, visibleSize: Size): Point {
  const [pw, ph] = previewSize;
  const [vw, vh] = visibleSize;
  return [(p[0] * pw) / vw, ph - (p[1] * ph) / vh];
}

/** Preview pixels per point (uniform when the preview keeps the page aspect, as the editor does). */
export function previewScale(previewSize: Size, visibleSize: Size): number {
  return previewSize[0] / visibleSize[0];
}

/** Rect spanned by two corners, in any order. */
export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
}

function boundsOfPoints(points: readonly Point[]): Rect {
  if (points.length === 0) return [0, 0, 0, 0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

/** Axis-aligned bounds of an item (geometry only, stroke width not included). */
export function itemBounds(item: Item): Rect {
  switch (item.kind) {
    case "line":
      return rectFromPoints(item.from, item.to);
    case "freehand":
      return boundsOfPoints(item.points);
    default:
      return item.rect;
  }
}

/** The item moved by `(dx, dy)` points. */
export function translateItem<T extends Item>(item: T, dx: number, dy: number): T {
  const shift = (p: Point): Point => [p[0] + dx, p[1] + dy];
  switch (item.kind) {
    case "line":
      return { ...item, from: shift(item.from), to: shift(item.to) };
    case "freehand":
      return { ...item, points: item.points.map(shift) };
    default: {
      const [x, y, w, h] = item.rect;
      return { ...item, rect: [x + dx, y + dy, w, h] };
    }
  }
}

export type BoxHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type LineHandle = "from" | "to";
export type Handle = BoxHandle | LineHandle;

const BOX_HANDLES: readonly BoxHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Resize handles of an item with their visible positions: 2 endpoints for a line, else 8. */
export function handlePositions(item: Item): { handle: Handle; point: Point }[] {
  if (item.kind === "line") {
    return [
      { handle: "from", point: item.from },
      { handle: "to", point: item.to },
    ];
  }
  const [x, y, w, h] = itemBounds(item);
  const pos: Record<BoxHandle, Point> = {
    nw: [x, y + h],
    n: [x + w / 2, y + h],
    ne: [x + w, y + h],
    e: [x + w, y + h / 2],
    se: [x + w, y],
    s: [x + w / 2, y],
    sw: [x, y],
    w: [x, y + h / 2],
  };
  return BOX_HANDLES.map((handle) => ({ handle, point: pos[handle] }));
}

/**
 * New box when `handle` is dragged to `point`: the opposite side or corner stays fixed, the box
 * never inverts and is at least `MIN_SIZE`. `keepAspect` keeps the width / height ratio (corner:
 * the larger scale wins; edge: the other side grows around its centre).
 */
export function resizeRect(rect: Rect, handle: BoxHandle, point: Point, keepAspect: boolean): Rect {
  const [x, y, w, h] = rect;
  let left = x;
  let right = x + w;
  let bottom = y;
  let top = y + h;
  const [px, py] = point;
  const movesW = handle.includes("w");
  const movesE = handle.includes("e");
  const movesN = handle.includes("n");
  const movesS = handle.includes("s");
  if (movesW) left = Math.min(px, right - MIN_SIZE);
  if (movesE) right = Math.max(px, left + MIN_SIZE);
  if (movesN) top = Math.max(py, bottom + MIN_SIZE);
  if (movesS) bottom = Math.min(py, top - MIN_SIZE);
  let nw = right - left;
  let nh = top - bottom;
  if (!keepAspect || w <= 0 || h <= 0) return [left, bottom, nw, nh];

  const aspect = w / h;
  const horizontal = movesW || movesE;
  const vertical = movesN || movesS;
  if (horizontal && vertical) {
    const scale = Math.max(nw / w, nh / h);
    nw = Math.max(MIN_SIZE, w * scale);
    nh = nw / aspect;
    // The corner opposite the handle stays put.
    const nx = movesW ? right - nw : left;
    const ny = movesS ? top - nh : bottom;
    return [nx, ny, nw, nh];
  }
  if (horizontal) {
    nh = nw / aspect;
    const cy = y + h / 2;
    return [left, cy - nh / 2, nw, nh];
  }
  nw = nh * aspect;
  const cx = x + w / 2;
  return [cx - nw / 2, bottom, nw, nh];
}

/** Map `p` from box `from` to box `to` (a degenerate axis keeps its offset). */
function mapPoint(p: Point, from: Rect, to: Rect): Point {
  const [fx, fy, fw, fh] = from;
  const [tx, ty, tw, th] = to;
  return [
    fw > 0 ? tx + ((p[0] - fx) * tw) / fw : tx + (p[0] - fx),
    fh > 0 ? ty + ((p[1] - fy) * th) / fh : ty + (p[1] - fy),
  ];
}

/**
 * The item resized by dragging `handle` to `point`. Lines move the dragged endpoint (Shift keeps
 * the direction, only the length changes); freehand strokes are scaled to the new bounds.
 * A handle that does not apply to the kind returns the item unchanged.
 */
export function resizeItem<T extends Item>(item: T, handle: Handle, point: Point, keepAspect: boolean): T {
  if (item.kind === "line") {
    if (handle !== "from" && handle !== "to") return item;
    const fixed = handle === "from" ? item.to : item.from;
    const moved = handle === "from" ? item.from : item.to;
    let target: Point = point;
    if (keepAspect) {
      const dx = moved[0] - fixed[0];
      const dy = moved[1] - fixed[1];
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const t = ((point[0] - fixed[0]) * dx + (point[1] - fixed[1]) * dy) / len;
        target = [fixed[0] + (dx / len) * t, fixed[1] + (dy / len) * t];
      }
    }
    return handle === "from" ? { ...item, from: target } : { ...item, to: target };
  }
  if (handle === "from" || handle === "to") return item;
  if (item.kind === "freehand") {
    const bounds = itemBounds(item);
    const next = resizeRect(bounds, handle, point, keepAspect);
    return { ...item, points: item.points.map((p) => mapPoint(p, bounds, next)) };
  }
  return { ...item, rect: resizeRect(item.rect, handle, point, keepAspect) };
}

/** Distance from `p` to segment `a`-`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function inRect(p: Point, rect: Rect, slop: number): boolean {
  const [x, y, w, h] = rect;
  return p[0] >= x - slop && p[0] <= x + w + slop && p[1] >= y - slop && p[1] <= y + h + slop;
}

/**
 * Whether visible point `p` hits the item: boxes by their area (an outline-only rectangle too, so
 * it stays easy to grab), ellipses by the ellipse (grown by half the stroke), lines and strokes
 * within max(`slop`, width) of the path.
 */
export function hitTest(item: Item, p: Point, slop = HIT_SLOP): boolean {
  switch (item.kind) {
    case "line":
      return distanceToSegment(p, item.from, item.to) <= Math.max(slop, item.width);
    case "freehand": {
      const reach = Math.max(slop, item.width);
      const pts = item.points;
      if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) <= reach;
      for (let i = 1; i < pts.length; i++) {
        if (distanceToSegment(p, pts[i - 1], pts[i]) <= reach) return true;
      }
      return false;
    }
    case "ellipse": {
      const [x, y, w, h] = item.rect;
      const grow = item.stroke.kind === "none" ? 0 : item.width / 2;
      const rx = w / 2 + grow;
      const ry = h / 2 + grow;
      if (rx <= 0 || ry <= 0) return false;
      const nx = (p[0] - (x + w / 2)) / rx;
      const ny = (p[1] - (y + h / 2)) / ry;
      return nx * nx + ny * ny <= 1;
    }
    case "rect": {
      const grow = item.stroke.kind === "none" ? 0 : item.width / 2;
      return inRect(p, item.rect, grow);
    }
    default:
      return inRect(p, item.rect, 0);
  }
}

/** Topmost item of `page` under `p` (last in paint order), or null. */
export function hitTestItems(items: readonly Item[], page: number, p: Point, slop = HIT_SLOP): Item | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.page === page && hitTest(it, p, slop)) return it;
  }
  return null;
}
