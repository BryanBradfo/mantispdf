/** Freehand stroke simplification (Ramer-Douglas-Peucker). */
import { distanceToSegment } from "./geometry";
import { LIMITS, type Point } from "./model";

/** Default tolerance in points: below what a viewer can tell apart at 100 %. */
export const SIMPLIFY_TOLERANCE = 0.5;

/**
 * Ramer-Douglas-Peucker: keeps the end points and every point farther than `tolerance` from the
 * simplified path. Iterative (no recursion depth limit on long strokes). Returns a new array.
 */
export function rdp(points: readonly Point[], tolerance: number): Point[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    let maxDist = -1;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distanceToSegment(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index >= 0 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Simplify a stroke at `tolerance`, then keep doubling the tolerance until it has at most `cap`
 * points (the engine's per-stroke limit). Consecutive duplicate points are dropped first. At the
 * requested tolerance every input point stays within `tolerance` of the result (RDP guarantee,
 * per window; window ends are kept, so windows never add deviation). A tap (all points equal)
 * keeps two points so it still draws a dot.
 */
export function simplifyStroke(
  points: readonly Point[],
  tolerance = SIMPLIFY_TOLERANCE,
  cap: number = LIMITS.strokePoints,
): Point[] {
  const deduped: Point[] = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) deduped.push(p);
  }
  if (deduped.length === 1 && points.length > 1) return [deduped[0], deduped[0]];
  let tol = tolerance;
  let out = rdpChunked(deduped, tol);
  while (out.length > Math.max(2, cap)) {
    tol = tol > 0 ? tol * 2 : SIMPLIFY_TOLERANCE;
    // Re-simplifying the previous result is cheaper and only drops more points.
    out = rdpChunked(out, tol);
  }
  return out;
}

/** Window length of `rdpChunked`. */
const CHUNK = 1024;

/**
 * RDP on consecutive windows sharing their end points: worst case O(n * CHUNK) instead of O(n^2)
 * (a long wavy stroke made one pass over 60k points take seconds). Each window still keeps every
 * point farther than `tolerance`; only a few extra window ends survive.
 */
function rdpChunked(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= CHUNK) return rdp(points, tolerance);
  const out: Point[] = [];
  for (let start = 0; start < points.length - 1; start += CHUNK - 1) {
    const part = rdp(points.slice(start, Math.min(points.length, start + CHUNK)), tolerance);
    // The first point of every window after the first is the previous window's last.
    out.push(...(start === 0 ? part : part.slice(1)));
  }
  return out;
}
