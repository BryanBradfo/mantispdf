import { describe, expect, it } from "vitest";
import { MAX_MARKS, addMarks, canRedo, canUndo, clearMarks, initialMarks, redo, removeMark, togglePage, undo, updateMark } from "./model";

describe("redaction marks", () => {
  it("adds areas, search matches and whole pages with fresh ids", () => {
    let s = initialMarks();
    s = addMarks(s, [
      { kind: "area", page: 1, rect: [0, 0, 10, 10] },
      { kind: "search", page: 2, rect: [5, 5, 20, 8], query: "secret" },
    ]);
    s = togglePage(s, 3);
    expect(s.marks.map((m) => [m.kind, m.page])).toEqual([
      ["area", 1],
      ["search", 2],
      ["page", 3],
    ]);
    expect(new Set(s.marks.map((m) => m.id)).size).toBe(3);
  });

  it("toggling a page twice removes its mark; removing by id works", () => {
    let s = togglePage(togglePage(initialMarks(), 4), 4);
    expect(s.marks).toEqual([]);
    s = addMarks(s, [{ kind: "area", page: 1, rect: [0, 0, 1, 1] }]);
    s = removeMark(s, s.marks[0].id);
    expect(s.marks).toEqual([]);
  });

  it("drops empty areas and stops at the engine's limit", () => {
    let s = addMarks(initialMarks(), [{ kind: "area", page: 1, rect: [0, 0, 0, 5] }]);
    expect(s.marks).toEqual([]);
    const many = Array.from({ length: MAX_MARKS + 5 }, () => ({ kind: "area" as const, page: 1, rect: [0, 0, 1, 1] as [number, number, number, number] }));
    s = addMarks(s, many);
    expect(s.marks.length).toBe(MAX_MARKS);
  });

  it("undoes and redoes every change, a new change clears redo", () => {
    let s = initialMarks();
    expect(canUndo(s)).toBe(false);
    s = addMarks(s, [{ kind: "area", page: 1, rect: [0, 0, 1, 1] }]);
    s = togglePage(s, 2);
    s = undo(s);
    expect(s.marks.map((m) => m.kind)).toEqual(["area"]);
    expect(canRedo(s)).toBe(true);
    s = redo(s);
    expect(s.marks.map((m) => m.kind)).toEqual(["area", "page"]);
    s = undo(undo(s));
    expect(s.marks).toEqual([]);
    s = addMarks(s, [{ kind: "area", page: 5, rect: [0, 0, 1, 1] }]);
    expect(canRedo(s)).toBe(false);
    s = clearMarks(s);
    expect(s.marks).toEqual([]);
    expect(undo(s).marks.length).toBe(1);
    // Nothing to undo or redo: unchanged.
    expect(redo(s)).toBe(s);
  });

  it("moves or resizes an area or a search match as one undo step", () => {
    let s = addMarks(initialMarks(), [
      { kind: "area", page: 1, rect: [0, 0, 10, 10] },
      { kind: "search", page: 1, rect: [5, 5, 20, 8], query: "secret" },
    ]);
    const [area, match] = s.marks;
    s = updateMark(s, match.id, [4, 4, 30, 10]);
    expect(s.marks[1]).toEqual({ ...match, rect: [4, 4, 30, 10] });
    expect(s.marks[0]).toBe(area);
    s = undo(s);
    expect(s.marks[1].kind === "search" && s.marks[1].rect).toEqual([5, 5, 20, 8]);
  });

  it("ignores no-op updates, unknown ids, whole pages and empty rects", () => {
    let s = addMarks(initialMarks(), [{ kind: "area", page: 1, rect: [0, 0, 10, 10] }]);
    s = togglePage(s, 2);
    const [area, page] = s.marks;
    expect(updateMark(s, area.id, [0, 0, 10, 10])).toBe(s);
    expect(updateMark(s, "nope", [1, 1, 1, 1])).toBe(s);
    expect(updateMark(s, page.id, [1, 1, 1, 1])).toBe(s);
    expect(updateMark(s, area.id, [1, 1, 0, 5])).toBe(s);
  });
});

