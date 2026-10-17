import { describe, expect, it } from "vitest";
import { autoLandscape, fitInCell, nupCells, nupGrid, nupSheetSize, resizeLayout } from "./geometryLayout";

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("resizeLayout", () => {
  it("letter to A4 fit scales and centers", () => {
    const r = resizeLayout([612, 792], { size: [595, 842], orientation: "auto", mode: "fit", margin: 0 });
    expect(r.sheet).toEqual([595, 842]);
    expect(r.scale).toBeCloseTo(595 / 612, 9);
    close(r.rect, [0, (842 - 792 * (595 / 612)) / 2, 595, 792 * (595 / 612)]);
  });
  it("auto picks a landscape sheet for a landscape page", () => {
    expect(resizeLayout([792, 612], { size: [595, 842], orientation: "auto", mode: "fit", margin: 0 }).sheet).toEqual([842, 595]);
    expect(resizeLayout([792, 612], { size: [595, 842], orientation: "portrait", mode: "fit", margin: 0 }).sheet).toEqual([595, 842]);
  });
  it("extend never upscales", () => {
    const r = resizeLayout([200, 300], { size: [595, 842], orientation: "auto", mode: "extend", margin: 0 });
    expect(r.scale).toBe(1);
    close(r.rect, [197.5, 271, 200, 300]);
  });
  it("margin shrinks the available area", () => {
    const r = resizeLayout([600, 800], { size: [600, 800], orientation: "auto", mode: "fit", margin: 50 });
    expect(r.scale).toBeCloseTo(0.8333333, 5);
  });
});

describe("n-up", () => {
  it("grids", () => {
    expect(nupGrid(6, false)).toEqual([2, 3]);
    expect(nupGrid(6, true)).toEqual([3, 2]);
    expect(nupGrid(16, true)).toEqual([4, 4]);
    expect(autoLandscape(2) && autoLandscape(8) && !autoLandscape(4)).toBe(true);
  });
  it("sheet size honors auto, explicit and same", () => {
    expect(nupSheetSize({ perSheet: 2, sheet: [595, 842], orientation: "auto" }, [1, 1])).toEqual([842, 595]);
    expect(nupSheetSize({ perSheet: 4, sheet: [842, 595], orientation: "auto" }, [1, 1])).toEqual([595, 842]);
    expect(nupSheetSize({ perSheet: 4, sheet: "same", orientation: "landscape" }, [300, 500])).toEqual([500, 300]);
  });
  it("cell table matches the Rust engine (400x600, margin 10, gap 20)", () => {
    const cells = nupCells(4, [400, 600], "rows", 10, 20);
    close(cells[0], [10, 600 - 10 - 280, 180, 280]);
    close(cells[1], [210, 310, 180, 280]);
    close(cells[2], [10, 10, 180, 280]);
    const cols = nupCells(4, [400, 600], "columns", 10, 20);
    close(cols[1], [10, 10, 180, 280]);
    close(cols[2], [210, 310, 180, 280]);
  });
  it("landscape 6-up rows is 3 columns by 2 rows", () => {
    const cells = nupCells(6, [600, 400], "rows", 0, 0);
    expect(cells).toHaveLength(6);
    close(cells[2], [400, 200, 200, 200]);
    close(cells[3], [0, 0, 200, 200]);
  });
  it("no room gives no cells", () => {
    expect(nupCells(16, [200, 200], "rows", 90, 50)).toEqual([]);
  });
  it("fitInCell centers a page", () => {
    close(fitInCell([0, 0, 100, 100], [50, 100]), [25, 0, 50, 100]);
  });
});
