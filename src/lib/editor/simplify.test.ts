import { describe, expect, it } from "vitest";
import type { Point } from "./model";
import { rdp, simplifyStroke } from "./simplify";

describe("rdp", () => {
  it("drops points within the tolerance of a straight line", () => {
    const pts: Point[] = [[0, 0], [1, 0.2], [2, -0.3], [3, 0.1], [4, 0]];
    expect(rdp(pts, 0.5)).toEqual([[0, 0], [4, 0]]);
  });

  it("keeps corners farther than the tolerance", () => {
    const pts: Point[] = [[0, 0], [5, 0.1], [10, 0], [10, 5], [10, 10]];
    expect(rdp(pts, 0.5)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("keeps a point exactly at the tolerance out and one just above in", () => {
    expect(rdp([[0, 0], [5, 0.5], [10, 0]], 0.5)).toEqual([[0, 0], [10, 0]]);
    expect(rdp([[0, 0], [5, 0.51], [10, 0]], 0.5)).toHaveLength(3);
  });

  it("simplifies long strokes window by window with the same result on a straight run", () => {
    const pts: Point[] = Array.from({ length: 5000 }, (_, i) => [i, (i % 2) * 0.1] as Point);
    const out = simplifyStroke(pts);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual(pts[4999]);
    // Only window ends survive (5 windows of 1024).
    expect(out.length).toBeLessThanOrEqual(7);
  });

  it("handles short and closed strokes", () => {
    expect(rdp([], 0.5)).toEqual([]);
    expect(rdp([[1, 1]], 0.5)).toEqual([[1, 1]]);
    const loop: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(rdp(loop, 0.5)).toEqual(loop);
  });
});

describe("simplifyStroke", () => {
  it("uses 0.5 pt by default and drops repeated points", () => {
    const pts: Point[] = [[0, 0], [0, 0], [1, 0.4], [2, 0], [2, 0]];
    expect(simplifyStroke(pts)).toEqual([[0, 0], [2, 0]]);
    // A tap (all points equal) keeps two points so it still draws a dot.
    expect(simplifyStroke([[3, 3], [3, 3], [3, 3]])).toEqual([[3, 3], [3, 3]]);
  });

  it("caps a long wiggly stroke at 5000 points, quickly", () => {
    // 3000 waves of 30 samples: about 2 points per wave survive 0.5 pt, over the 5000 cap.
    const pts: Point[] = [];
    for (let i = 0; i < 90000; i++) pts.push([i * 0.2, 20 * Math.sin((i / 30) * 2 * Math.PI)]);
    expect(simplifyStroke(pts, 0.5, Infinity).length).toBeGreaterThan(5000);
    const t0 = performance.now();
    const out = simplifyStroke(pts);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(out.length).toBeLessThanOrEqual(5000);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it("honours a custom cap", () => {
    const pts: Point[] = Array.from({ length: 100 }, (_, i) => [i, (i % 2) * 10] as Point);
    expect(simplifyStroke(pts, 0.5, 10).length).toBeLessThanOrEqual(10);
  });
});
