import { describe, expect, it } from "vitest";
import {
  handlePositions,
  hitTest,
  hitTestItems,
  itemBounds,
  previewToVisiblePoint,
  previewToVisibleRect,
  rectFromPoints,
  resizeItem,
  resizeRect,
  visibleToPreviewPoint,
  visibleToPreviewRect,
} from "./geometry";
import type { EllipseItem, FreehandItem, Item, LineItem, RectItem } from "./model";

const box: RectItem = {
  id: "r",
  kind: "rect",
  page: 1,
  rect: [100, 100, 200, 100],
  stroke: { kind: "rgb", color: [0, 0, 0] },
  width: 2,
  fill: { kind: "none" },
  opacity: 1,
};
const ellipse: EllipseItem = { ...box, id: "e", kind: "ellipse", stroke: { kind: "none" } };
const line: LineItem = {
  id: "l",
  kind: "line",
  page: 1,
  from: [0, 0],
  to: [100, 0],
  color: [0, 0, 0],
  width: 10,
  opacity: 1,
  arrowStart: false,
  arrowEnd: false,
};
const stroke: FreehandItem = {
  id: "f",
  kind: "freehand",
  page: 1,
  points: [[0, 0], [10, 10], [20, 0]],
  color: [0, 0, 0],
  width: 1,
  opacity: 1,
};

describe("preview <-> visible mapping", () => {
  it("maps points like signPlacement maps rects (origin flip and scale)", () => {
    const preview: [number, number] = [306, 396];
    const page: [number, number] = [612, 792];
    expect(previewToVisiblePoint([50, 100], preview, page)).toEqual([100, 592]);
    expect(visibleToPreviewPoint([100, 592], preview, page)).toEqual([50, 100]);
    // A rect's preview top-left corner maps to the visible top-left corner (x, y + h).
    const r = previewToVisibleRect({ left: 50, top: 100, width: 60, height: 20 }, preview, page);
    expect([r[0], r[1] + r[3]]).toEqual(previewToVisiblePoint([50, 100], preview, page));
    expect(visibleToPreviewRect(r, preview, page)).toEqual({ left: 50, top: 100, width: 60, height: 20 });
  });

  it("uses the rotated size for a /Rotate 90 page", () => {
    const p = previewToVisiblePoint([528, 408], [528, 408], [792, 612]);
    expect(p[0]).toBeCloseTo(792);
    expect(p[1]).toBeCloseTo(0);
  });
});

describe("bounds and handles", () => {
  it("bounds a line and a stroke", () => {
    expect(itemBounds(line)).toEqual([0, 0, 100, 0]);
    expect(itemBounds(stroke)).toEqual([0, 0, 20, 10]);
    expect(rectFromPoints([5, 9], [1, 2])).toEqual([1, 2, 4, 7]);
  });

  it("gives 8 handles to boxes and 2 endpoints to lines", () => {
    const h = handlePositions(box);
    expect(h).toHaveLength(8);
    expect(h.find((x) => x.handle === "nw")?.point).toEqual([100, 200]);
    expect(h.find((x) => x.handle === "se")?.point).toEqual([300, 100]);
    expect(h.find((x) => x.handle === "e")?.point).toEqual([300, 150]);
    expect(handlePositions(line)).toEqual([
      { handle: "from", point: [0, 0] },
      { handle: "to", point: [100, 0] },
    ]);
    expect(handlePositions(stroke)).toHaveLength(8);
  });
});

describe("resize", () => {
  it("keeps the opposite edge and never inverts", () => {
    expect(resizeRect([0, 0, 100, 50], "w", [20, 999], false)).toEqual([20, 0, 80, 50]);
    expect(resizeRect([0, 0, 100, 50], "n", [999, 80], false)).toEqual([0, 0, 100, 80]);
    expect(resizeRect([0, 0, 100, 50], "e", [-50, 0], false)).toEqual([0, 0, 1, 50]);
  });

  it("keeps the aspect from a corner with the larger scale, opposite corner fixed", () => {
    expect(resizeRect([0, 0, 100, 50], "nw", [-100, 60], true)).toEqual([-100, 0, 200, 100]);
    expect(resizeRect([0, 0, 100, 50], "sw", [50, 40], true)).toEqual([50, 25, 50, 25]);
  });

  it("keeps the aspect from an edge by growing the other side around its centre", () => {
    expect(resizeRect([0, 0, 100, 50], "e", [200, 0], true)).toEqual([0, -25, 200, 100]);
  });

  it("never derives a side under the minimum size with keepAspect", () => {
    // Wide box squeezed from the east: width 1, height would be 0.01.
    const [, , w, h] = resizeRect([0, 0, 100, 1], "e", [-50, 0], true);
    expect(w).toBe(1);
    expect(h).toBe(1);
    // Tall box squeezed from the north: width would be 0.01.
    const r = resizeRect([0, 0, 1, 100], "n", [0, -50], true);
    expect(r[2]).toBe(1);
    expect(r[3]).toBe(1);
    // Corner too.
    const c = resizeRect([0, 0, 100, 1], "se", [-50, 50], true);
    expect(c[2]).toBeGreaterThanOrEqual(1);
    expect(c[3]).toBeGreaterThanOrEqual(1);
  });

  it("moves a line endpoint, and keeps the direction with keepAspect", () => {
    const moved = resizeItem(line, "to", [50, 50], false);
    expect(moved.to).toEqual([50, 50]);
    expect(moved.from).toEqual([0, 0]);
    const along = resizeItem(line, "to", [50, 50], true);
    expect(along.to).toEqual([50, 0]);
    expect(resizeItem(line, "se", [1, 1], false)).toBe(line);
  });

  it("scales a stroke into the new bounds", () => {
    const r = resizeItem(stroke, "ne", [40, 20], false);
    expect(r.points).toEqual([[0, 0], [20, 20], [40, 0]]);
  });
});

describe("hit testing", () => {
  it("hits a filled rectangle anywhere inside or on its stroke", () => {
    const filled: RectItem = { ...box, fill: { kind: "rgb", color: [1, 0, 0] } };
    expect(hitTest(filled, [200, 150])).toBe(true);
    expect(hitTest(filled, [300.9, 150])).toBe(true);
    expect(hitTest(filled, [302, 150])).toBe(false);
  });

  it("hits an outline-only rectangle near its frame only", () => {
    expect(hitTest(box, [200, 150])).toBe(false);
    expect(hitTest(box, [300, 150])).toBe(true);
    expect(hitTest(box, [303.9, 150])).toBe(true);
    expect(hitTest(box, [296.1, 150])).toBe(true);
    expect(hitTest(box, [295.9, 150])).toBe(false);
    expect(hitTest(box, [304.1, 150])).toBe(false);
    // A thick stroke widens the band to half its width.
    expect(hitTest({ ...box, width: 20 }, [291, 150])).toBe(true);
    // Too small for a hole: the whole area hits.
    expect(hitTest({ ...box, rect: [0, 0, 6, 6] }, [3, 3])).toBe(true);
  });

  it("hits a filled ellipse inside the curve only", () => {
    const filled: EllipseItem = { ...ellipse, fill: { kind: "rgb", color: [1, 0, 0] } };
    expect(hitTest(filled, [200, 150])).toBe(true);
    expect(hitTest(filled, [105, 105])).toBe(false);
    expect(hitTest(filled, [299, 150])).toBe(true);
  });

  it("hits an outline-only ellipse on a ring around the curve", () => {
    expect(hitTest(ellipse, [200, 150])).toBe(false);
    expect(hitTest(ellipse, [299, 150])).toBe(true);
    expect(hitTest(ellipse, [303, 150])).toBe(true);
    expect(hitTest(ellipse, [200, 202])).toBe(true);
    expect(hitTest(ellipse, [200, 190])).toBe(false);
    expect(hitTest(ellipse, [105, 105])).toBe(false);
  });

  it("a click inside an empty frame selects the item beneath it", () => {
    const text: Item = {
      id: "t",
      kind: "text",
      page: 1,
      rect: [150, 120, 100, 50],
      text: "x",
      font: "Helvetica",
      size: 12,
      color: [0, 0, 0],
      opacity: 1,
      align: "left",
      lineHeight: 1.2,
    };
    expect(hitTestItems([text, box], 1, [200, 150])?.id).toBe("t");
    expect(hitTestItems([text, ellipse], 1, [200, 150])?.id).toBe("t");
    expect(hitTestItems([text, box], 1, [100, 150])?.id).toBe("r");
  });

  it("hits a line within max(4, width)", () => {
    expect(hitTest(line, [50, 9.9])).toBe(true);
    expect(hitTest(line, [50, 10.1])).toBe(false);
    const thin = { ...line, width: 1 };
    expect(hitTest(thin, [50, 3.9])).toBe(true);
    expect(hitTest(thin, [50, 4.1])).toBe(false);
    // Beyond the end the distance is to the endpoint.
    expect(hitTest(thin, [103, 0])).toBe(true);
    expect(hitTest(thin, [105, 0])).toBe(false);
  });

  it("hits a stroke near any segment", () => {
    expect(hitTest(stroke, [5, 5])).toBe(true);
    expect(hitTest(stroke, [10, 0])).toBe(false);
    expect(hitTest(stroke, [10, 7])).toBe(true);
  });

  it("returns the topmost item of the page", () => {
    const filled: RectItem = { ...box, fill: { kind: "rgb", color: [1, 0, 0] } };
    const top: Item = { ...filled, id: "top" };
    const other: Item = { ...filled, id: "other", page: 2 };
    expect(hitTestItems([filled, top, other], 1, [200, 150])?.id).toBe("top");
    expect(hitTestItems([filled, top, other], 2, [200, 150])?.id).toBe("other");
    expect(hitTestItems([box], 1, [0, 0])).toBeNull();
  });
});
