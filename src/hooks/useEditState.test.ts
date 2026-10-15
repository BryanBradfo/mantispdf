import { describe, it, expect } from "vitest";
import { editReducer, type EditState } from "./useEditState";

const loaded = (n: number): EditState =>
  editReducer(
    { file: null, pdfBytes: null, numPages: 0, pageOrder: [], deletedPages: new Set(), uploadError: null },
    { type: "file-loaded", file: new File([], "x.pdf"), pdfBytes: new Uint8Array(), numPages: n },
  );

describe("editReducer reorder", () => {
  it("moves a page forward", () => {
    expect(editReducer(loaded(4), { type: "reorder", from: 0, to: 2 }).pageOrder).toEqual([2, 3, 1, 4]);
  });
  it("moves a page backward", () => {
    expect(editReducer(loaded(4), { type: "reorder", from: 3, to: 0 }).pageOrder).toEqual([4, 1, 2, 3]);
  });
  it("keeps deleted marks attached to original page numbers", () => {
    let s = editReducer(loaded(3), { type: "toggle-delete", page: 1 });
    s = editReducer(s, { type: "reorder", from: 0, to: 2 });
    expect(s.pageOrder).toEqual([2, 3, 1]);
    expect([...s.deletedPages]).toEqual([1]);
  });
  it("ignores out-of-range indices", () => {
    const s = loaded(3);
    expect(editReducer(s, { type: "reorder", from: 5, to: 0 })).toBe(s);
  });
});
