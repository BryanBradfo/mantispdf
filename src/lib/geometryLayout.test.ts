import { describe, expect, it } from "vitest";
import { autoLandscape, fitInCell, mmSizeLabel, nupCells, nupGrid, nupProblem, nupSheetSize, resizeLayout, resizeProblem, type Size } from "./geometryLayout";
import { tFor } from "../i18n/testUtils";

const tGeo = tFor("geometry");

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

describe("resizeProblem", () => {
  const ok = { selected: 3, size: [595, 842] as Size, marginMm: 10 };
  it("accepts valid settings", () => {
    expect(resizeProblem(ok, tGeo)).toBeNull();
  });
  it("explains each refusal", () => {
    expect(resizeProblem({ ...ok, selected: 0 }, tGeo)).toBe("Select at least one page.");
    expect(resizeProblem({ ...ok, size: null }, tGeo)).toBe("Custom size must be between 13 and 5080 mm on each side.");
    expect(resizeProblem({ ...ok, marginMm: NaN }, tGeo)).toBe("Margin must be between 0 and 200 mm.");
  });
  it("refuses a margin that leaves no room on the sheet", () => {
    // 50 mm custom sheet (141.7 pt): two 25 mm margins take all of it.
    expect(resizeProblem({ ...ok, size: [141.73, 400], marginMm: 25 }, tGeo)).toBe(
      "The margin leaves no room on the sheet. Use a smaller margin.",
    );
    expect(resizeProblem({ ...ok, size: [141.73, 400], marginMm: 24 }, tGeo)).toBeNull();
  });
});

describe("nupProblem", () => {
  const ok = { perSheet: 4 as const, sheet: [595, 842] as Size, orientation: "auto" as const, order: "rows" as const, first: [612, 792] as Size, marginMm: 10, gapMm: 5 };
  it("accepts valid settings", () => {
    expect(nupProblem(ok, tGeo)).toBeNull();
    expect(nupProblem({ ...ok, sheet: "same" }, tGeo)).toBeNull();
  });
  it("refuses a first page out of 36..14400 pt as the sheet size", () => {
    const msg = "The first page is too small or too large to be the sheet size (1 to 200 in). Pick a paper size.";
    expect(nupProblem({ ...ok, sheet: "same", first: [20, 792] }, tGeo)).toBe(msg);
    expect(nupProblem({ ...ok, sheet: "same", first: [612, 15000] }, tGeo)).toBe(msg);
    expect(nupProblem({ ...ok, sheet: "same", first: [36, 14400], marginMm: 0, gapMm: 0 }, tGeo)).toBeNull();
  });
  it("tells a margin with no room from a gap with no room", () => {
    expect(nupProblem({ ...ok, sheet: [100, 200], marginMm: 18 }, tGeo)).toBe(
      "The margin leaves no room on the sheet. Use a smaller margin.",
    );
    expect(nupProblem({ ...ok, perSheet: 16, sheet: [200, 200], marginMm: 30, gapMm: 20 }, tGeo)).toBe(
      "The margin and gap leave no room for the pages.",
    );
  });
  it("checks the custom size and ranges", () => {
    expect(nupProblem({ ...ok, sheet: null }, tGeo)).toBe("Custom size must be between 13 and 5080 mm on each side.");
    expect(nupProblem({ ...ok, marginMm: 201 }, tGeo)).toBe("Margin must be between 0 and 200 mm.");
    expect(nupProblem({ ...ok, gapMm: NaN }, tGeo)).toBe("Gap must be between 0 and 200 mm.");
  });
});

describe("mmSizeLabel", () => {
  it("never shows NaN", () => {
    expect(mmSizeLabel([210, 297], tGeo)).toBe("210 x 297 mm");
    expect(mmSizeLabel([NaN, 297], tGeo)).toBe("? x 297 mm");
  });
});

describe("geometry messages in French", () => {
  const t = tFor("geometry", "fr");
  it("explains the problems in French", () => {
    expect(resizeProblem({ selected: 0, size: [595, 842], marginMm: 0 }, t)).toBe("Sélectionnez au moins une page.");
    expect(nupProblem({ perSheet: 4, sheet: [595, 842], orientation: "auto", order: "rows", first: [612, 792], marginMm: 0, gapMm: NaN }, t)).toBe(
      "L’espacement doit être compris entre 0 et 200\u00a0mm.",
    );
    expect(mmSizeLabel([210, NaN], t)).toBe("210 × ?\u00a0mm");
  });
});
