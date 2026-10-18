import { describe, expect, it } from "vitest";
import type { FormField, FormWidget } from "./model";
import { tabOrder } from "./tabOrder";

const at = (page: number, x: number, top: number, extra: Partial<FormWidget> = {}): FormWidget => ({
  page,
  rect: [x, top - 20, x + 50, top],
  rotation: 0,
  onState: null,
  hidden: false,
  font: "Helvetica",
  fontSize: 0,
  annotIndex: null,
  tabs: null,
  align: 0,
  ...extra,
});
const placed = (id: number, ...widgets: FormWidget[]): FormField => ({
  id,
  name: `f${id}`,
  label: `f${id}`,
  kind: { kind: "checkbox" },
  readOnly: false,
  required: false,
  value: { kind: "none" },
  options: [],
  onStates: [],
  widgets,
});
const ids = (fields: FormField[]) => tabOrder(fields).map((f) => f.id);

describe("tab order", () => {
  it("orders by page, then rows top to bottom, then left to right", () => {
    const fields = [
      placed(0, at(2, 10, 700)),
      placed(1, at(1, 300, 500)),
      placed(2, at(1, 10, 503)), // same row as 1 (3 pt higher): left first
      placed(3, at(1, 10, 700)),
      placed(4, at(1, 200, 700)),
      placed(5, at(1, 10, 495)), // 8 pt below 2: next row
    ];
    expect(ids(fields)).toEqual([3, 4, 2, 1, 5, 0]);
  });

  it("uses the 4 pt row tolerance from the row's first field", () => {
    expect(ids([placed(0, at(1, 100, 500)), placed(1, at(1, 10, 496))])).toEqual([1, 0]);
    expect(ids([placed(0, at(1, 100, 500)), placed(1, at(1, 10, 495.9))])).toEqual([0, 1]);
  });

  it("anchors a field on its first drawn widget and puts undrawn fields last", () => {
    const fields = [
      placed(0, at(0, 10, 790)), // orphan only
      placed(1, at(1, 10, 790, { hidden: true }), at(1, 10, 100)),
      placed(2, at(1, 10, 400), at(1, 10, 50)),
      placed(3),
    ];
    expect(ids(fields)).toEqual([2, 1, 0, 3]);
  });

  describe("page /Tabs", () => {
    // A 2 x 2 grid: a = top left, b = top right, c = bottom left, d = bottom right.
    const grid = (tabs: FormWidget["tabs"], order: number[] = [0, 1, 2, 3]) => [
      placed(0, at(1, 10, 700, { tabs, annotIndex: order[0] })),
      placed(1, at(1, 300, 700, { tabs, annotIndex: order[1] })),
      placed(2, at(1, 10, 400, { tabs, annotIndex: order[2] })),
      placed(3, at(1, 300, 400, { tabs, annotIndex: order[3] })),
    ];

    it("R and no /Tabs: rows", () => {
      expect(ids(grid("R"))).toEqual([0, 1, 2, 3]);
      expect(ids(grid(null))).toEqual([0, 1, 2, 3]);
    });

    it("C: columns left to right, each top to bottom", () => {
      expect(ids(grid("C"))).toEqual([0, 2, 1, 3]);
    });

    it("C groups a column within the 4 pt tolerance from its first field", () => {
      const fields = [placed(0, at(1, 13, 400, { tabs: "C" })), placed(1, at(1, 10, 700, { tabs: "C" })), placed(2, at(1, 15, 300, { tabs: "C" }))];
      // 0 and 1 are one column (3 pt apart), 2 is 5 pt right of 1: the next column.
      expect(ids(fields)).toEqual([1, 0, 2]);
    });

    it("S: the page's annotation order, fields without an index after them in rows", () => {
      expect(ids(grid("S", [3, 0, 2, 1]))).toEqual([1, 3, 2, 0]);
      const mixed = [
        placed(0, at(1, 10, 700, { tabs: "S", annotIndex: null })),
        placed(1, at(1, 10, 100, { tabs: "S", annotIndex: 5 })),
        placed(2, at(1, 10, 400, { tabs: "S", annotIndex: 2 })),
      ];
      expect(ids(mixed)).toEqual([2, 1, 0]);
    });

    it("applies each page's own /Tabs, pages still in order", () => {
      const fields = [
        placed(0, at(2, 300, 700, { tabs: "C" })),
        placed(1, at(2, 10, 400, { tabs: "C" })),
        placed(2, at(1, 300, 700, { tabs: "R" })),
        placed(3, at(1, 10, 400, { tabs: "R" })),
      ];
      expect(ids(fields)).toEqual([2, 3, 1, 0]);
    });

    it("S uses the field's lowest annotation index on its anchor page", () => {
      const fields = [
        placed(0, at(1, 10, 700, { tabs: "S", annotIndex: 4 }), at(1, 10, 100, { tabs: "S", annotIndex: 1 })),
        placed(1, at(1, 10, 500, { tabs: "S", annotIndex: 2 })),
      ];
      expect(ids(fields)).toEqual([0, 1]);
    });
  });
});

