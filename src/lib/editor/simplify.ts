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
 * points (the engine's per-stroke limit). Points closer than `tolerance` to the previous kept
 * point are dropped first (cheap, and dense coalesced pointer input shrinks a lot); the last point
 * is always kept.
 */
export function simplifyStroke(
  points: readonly Point[],
  tolerance = SIMPLIFY_TOLERANCE,
  cap: number = LIMITS.strokePoints,
): Point[] {
  if (points.length <= 2) return points.slice();
  const near: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = near[near.length - 1];
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) > tolerance) near.push(points[i]);
  }
  const end = points[points.length - 1];
  const last = near[near.length - 1];
  if (near.length === 1 || last[0] !== end[0] || last[1] !== end[1]) near.push(end);
  let tol = tolerance;
  let out = rdpChunked(near, tol);
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
