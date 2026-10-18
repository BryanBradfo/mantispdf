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
});
