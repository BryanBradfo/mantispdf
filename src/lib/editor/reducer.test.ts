import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, initialEditorState, type EditorState, type NewItem } from "./model";
import { DUPLICATE_OFFSET, editorReducer, type EditorAction } from "./reducer";

const rect = (page = 1, x = 10): NewItem => ({
  kind: "rect",
  page,
  rect: [x, 20, 100, 50],
  stroke: { kind: "rgb", color: [0, 0, 0] },
  width: 2,
  fill: { kind: "none" },
  opacity: 1,
});

const line = (page = 1): NewItem => ({
  kind: "line",
  page,
  from: [0, 0],
  to: [100, 0],
  color: [1, 0, 0],
  width: 2,
  opacity: 1,
  arrowStart: false,
  arrowEnd: true,
});

function run(actions: EditorAction[], state: EditorState = initialEditorState()): EditorState {
  return actions.reduce(editorReducer, state);
}

describe("editorReducer", () => {
  it("adds items with unique ids and selects the new one", () => {
    const s = run([{ type: "add", item: rect() }, { type: "add", item: line() }]);
    expect(s.items.map((it) => it.id)).toEqual(["item-1", "item-2"]);
    expect(s.selectedId).toBe("item-2");
    expect(s.past).toHaveLength(2);
  });

  it("merges props without changing the kind or id", () => {
    let s = run([{ type: "add", item: rect() }]);
    s = editorReducer(s, { type: "update", id: "item-1", props: { opacity: 0.5, fill: { kind: "rgb", color: [1, 1, 0] } } });
    const it = s.items[0];
    expect(it.kind).toBe("rect");
    expect(it.id).toBe("item-1");
    if (it.kind !== "rect") throw new Error("kind");
    expect(it.opacity).toBe(0.5);
    expect(it.fill).toEqual({ kind: "rgb", color: [1, 1, 0] });
    expect(it.width).toBe(2);
    // A key the kind does not have is ignored.
    const before = s;
    s = editorReducer(s, { type: "update", id: "item-1", props: { text: "x" } as never });
    expect(s).toBe(before);
  });

  it("an update that changes nothing is not an undo step", () => {
    const s = run([{ type: "add", item: rect() }]);
    const next = editorReducer(s, { type: "update", id: "item-1", props: { opacity: 1 } });
    expect(next).toBe(s);
  });

  it("moves boxes, lines and strokes", () => {
    let s = run([
      { type: "add", item: rect() },
      { type: "add", item: line() },
      { type: "add", item: { kind: "freehand", page: 1, points: [[0, 0], [5, 5]], color: [0, 0, 0], width: 1, opacity: 1 } },
    ]);
    for (const id of ["item-1", "item-2", "item-3"]) s = editorReducer(s, { type: "move", id, dx: 3, dy: -4 });
    const [r, l, f] = s.items;
    expect(r.kind === "rect" && r.rect).toEqual([13, 16, 100, 50]);
    expect(l.kind === "line" && [l.from, l.to]).toEqual([[3, -4], [103, -4]]);
    expect(f.kind === "freehand" && f.points).toEqual([[3, -4], [8, 1]]);
  });

  it("resizes with a handle, keeping the aspect on request", () => {
    let s = run([{ type: "add", item: rect() }]);
    // se corner dragged: nw corner (10, 70) stays.
    s = editorReducer(s, { type: "resize", id: "item-1", handle: "se", point: [210, 0], keepAspect: false });
    expect(s.items[0].kind === "rect" && s.items[0].rect).toEqual([10, 0, 200, 70]);
    s = run([{ type: "add", item: rect() }]);
    s = editorReducer(s, { type: "resize", id: "item-1", handle: "se", point: [310, 50], keepAspect: true });
    // Scale 3 on x wins: 300 x 150, top edge (70) fixed.
    expect(s.items[0].kind === "rect" && s.items[0].rect).toEqual([10, -80, 300, 150]);
  });

  it("deletes the selection and clears it", () => {
    const s = run([{ type: "add", item: rect() }, { type: "delete" }]);
    expect(s.items).toEqual([]);
    expect(s.selectedId).toBeNull();
  });

  it("duplicates with an offset, a new id, on top and selected", () => {
    const s = run([{ type: "add", item: rect() }, { type: "add", item: line() }, { type: "duplicate", id: "item-1" }]);
    expect(s.items).toHaveLength(3);
    const copy = s.items[2];
    expect(copy.id).toBe("item-3");
    expect(copy.kind === "rect" && copy.rect).toEqual([10 + DUPLICATE_OFFSET, 20 - DUPLICATE_OFFSET, 100, 50]);
    expect(s.selectedId).toBe("item-3");
  });

  it("brings forward and sends backward among the same page's items", () => {
    let s = run([
      { type: "add", item: rect(1) },
      { type: "add", item: rect(2) },
      { type: "add", item: rect(1) },
    ]);
    s = editorReducer(s, { type: "forward", id: "item-1" });
    expect(s.items.map((it) => it.id)).toEqual(["item-3", "item-2", "item-1"]);
    // Already on top of page 1: no change, no undo step.
    const top = editorReducer(s, { type: "forward", id: "item-1" });
    expect(top).toBe(s);
    s = editorReducer(s, { type: "backward", id: "item-1" });
    expect(s.items.map((it) => it.id)).toEqual(["item-1", "item-2", "item-3"]);
  });

  it("undoes and redoes every kind of change", () => {
    let s = run([
      { type: "add", item: rect() },
      { type: "move", id: "item-1", dx: 5, dy: 0 },
      { type: "update", id: "item-1", props: { width: 4 } },
      { type: "delete", id: "item-1" },
    ]);
    const states: EditorState["items"][] = [];
    states.push(s.items);
    for (let i = 0; i < 4; i++) {
      s = editorReducer(s, { type: "undo" });
      states.push(s.items);
    }
    expect(s.items).toEqual([]);
    expect(states[1]).toHaveLength(1);
    expect(states[1][0].kind === "rect" && states[1][0].width).toBe(4);
    expect(states[2][0].kind === "rect" && states[2][0].width).toBe(2);
    expect(states[3][0].kind === "rect" && states[3][0].rect[0]).toBe(10);
    // Nothing more to undo.
    expect(editorReducer(s, { type: "undo" }).items).toBe(s.items);
    for (let i = 3; i >= 0; i--) {
      s = editorReducer(s, { type: "redo" });
      expect(s.items).toBe(states[i]);
    }
    expect(editorReducer(s, { type: "redo" }).items).toBe(s.items);
  });

  it("a new change after an undo drops the redo stack", () => {
    const s = run([{ type: "add", item: rect() }, { type: "add", item: line() }, { type: "undo" }, { type: "add", item: rect() }]);
    expect(s.future).toEqual([]);
    expect(s.items.map((it) => it.kind)).toEqual(["rect", "rect"]);
  });

  it("caps the history at 100 steps", () => {
    let s = run([{ type: "add", item: rect() }]);
    for (let i = 0; i < 150; i++) s = editorReducer(s, { type: "move", id: "item-1", dx: 1, dy: 0 });
    expect(s.past).toHaveLength(HISTORY_LIMIT);
    for (let i = 0; i < 200; i++) s = editorReducer(s, { type: "undo" });
    // The oldest 51 steps (add + 50 moves) were dropped: the item stays, moved 50 pt.
    expect(s.items).toHaveLength(1);
    expect(s.items[0].kind === "rect" && s.items[0].rect[0]).toBe(60);
    expect(s.future).toHaveLength(HISTORY_LIMIT);
  });

  it("a drag is a single undo step", () => {
    let s = run([{ type: "add", item: rect() }]);
    const pastBefore = s.past.length;
    s = editorReducer(s, { type: "beginGesture" });
    for (let i = 0; i < 20; i++) s = editorReducer(s, { type: "move", id: "item-1", dx: 1, dy: 1 });
    expect(s.past).toHaveLength(pastBefore);
    s = editorReducer(s, { type: "endGesture" });
    expect(s.past).toHaveLength(pastBefore + 1);
    expect(s.items[0].kind === "rect" && s.items[0].rect).toEqual([30, 40, 100, 50]);
    s = editorReducer(s, { type: "undo" });
    expect(s.items[0].kind === "rect" && s.items[0].rect).toEqual([10, 20, 100, 50]);
    s = editorReducer(s, { type: "redo" });
    expect(s.items[0].kind === "rect" && s.items[0].rect).toEqual([30, 40, 100, 50]);
  });

  it("a resize drag is a single undo step too", () => {
    let s = run([{ type: "add", item: rect() }, { type: "beginGesture" }]);
    for (let x = 120; x < 200; x += 10) {
      s = editorReducer(s, { type: "resize", id: "item-1", handle: "e", point: [x, 0], keepAspect: false });
    }
    s = editorReducer(s, { type: "endGesture" });
    expect(s.past).toHaveLength(2);
    s = editorReducer(s, { type: "undo" });
    expect(s.items[0].kind === "rect" && s.items[0].rect).toEqual([10, 20, 100, 50]);
  });

  it("a gesture that changes nothing adds no undo step", () => {
    const s0 = run([{ type: "add", item: rect() }]);
    const s = run([{ type: "beginGesture" }, { type: "select", id: "item-1" }, { type: "endGesture" }], s0);
    expect(s.past).toHaveLength(s0.past.length);
    expect(s.gestureBase).toBeNull();
  });

  it("undo during a gesture commits it first, then undoes it", () => {
    const s = run([
      { type: "add", item: rect() },
      { type: "beginGesture" },
      { type: "move", id: "item-1", dx: 5, dy: 0 },
      { type: "undo" },
    ]);
    expect(s.items[0].kind === "rect" && s.items[0].rect[0]).toBe(10);
    expect(s.gestureBase).toBeNull();
    expect(s.future).toHaveLength(1);
  });

  it("undo and redo across page switches never lose or duplicate items", () => {
    let s = run([
      { type: "add", item: rect(1) },
      { type: "setPage", page: 2 },
      { type: "add", item: line(2) },
      { type: "setPage", page: 3 },
    ]);
    expect(s.page).toBe(3);
    // Page switches are not undo steps: the first undo removes the page 2 line and shows page 2.
    s = editorReducer(s, { type: "undo" });
    expect(s.items.map((it) => it.id)).toEqual(["item-1"]);
    expect(s.page).toBe(2);
    s = editorReducer(s, { type: "setPage", page: 1 });
    s = editorReducer(s, { type: "undo" });
    expect(s.items).toEqual([]);
    expect(s.page).toBe(1);
    s = editorReducer(s, { type: "setPage", page: 3 });
    s = editorReducer(s, { type: "redo" });
    expect(s.items.map((it) => [it.id, it.page])).toEqual([["item-1", 1]]);
    expect(s.page).toBe(1);
    s = editorReducer(s, { type: "redo" });
    expect(s.items.map((it) => [it.id, it.page])).toEqual([["item-1", 1], ["item-2", 2]]);
    expect(s.page).toBe(2);
    // Ids stay unique after history moves.
    s = editorReducer(s, { type: "add", item: rect(2) });
    expect(new Set(s.items.map((it) => it.id)).size).toBe(3);
  });

  it("setPage deselects and keeps history", () => {
    const s = run([{ type: "add", item: rect() }, { type: "setPage", page: 2 }]);
    expect(s.selectedId).toBeNull();
    expect(s.past).toHaveLength(1);
  });

  it("undoing a delete selects the restored item", () => {
    let s = run([{ type: "add", item: rect() }, { type: "add", item: line() }, { type: "delete", id: "item-1" }]);
    expect(s.selectedId).toBe("item-2");
    s = editorReducer(s, { type: "undo" });
    expect(s.items.map((it) => it.id)).toEqual(["item-1", "item-2"]);
    expect(s.selectedId).toBe("item-1");
    // On another page: the editor goes there and selects it too.
    s = run([{ type: "add", item: rect(1) }, { type: "delete" }, { type: "setPage", page: 4 }, { type: "undo" }]);
    expect(s.page).toBe(1);
    expect(s.selectedId).toBe("item-1");
  });

  it("undo clears a selection whose item is gone", () => {
    const s = run([{ type: "add", item: rect() }, { type: "undo" }]);
    expect(s.selectedId).toBeNull();
  });

  it("select ignores unknown ids", () => {
    const s = run([{ type: "add", item: rect() }, { type: "select", id: null }]);
    expect(editorReducer(s, { type: "select", id: "nope" })).toBe(s);
    expect(editorReducer(s, { type: "select", id: "item-1" }).selectedId).toBe("item-1");
  });

  it("cancelGesture puts the items back as they were when the gesture began, without history", () => {
    const s0 = run([{ type: "add", item: rect() }]);
    let s = editorReducer(s0, { type: "beginGesture" });
    s = editorReducer(s, { type: "move", id: "item-1", dx: 30, dy: 5 });
    s = editorReducer(s, { type: "cancelGesture" });
    expect(s.items).toBe(s0.items);
    expect(s.past).toBe(s0.past);
    expect(s.future).toBe(s0.future);
    expect(s.gestureBase).toBeNull();
    expect(s.selectedId).toBe("item-1");
  });

  it("cancelGesture drops an item added inside the gesture and clears its selection", () => {
    const s0 = run([{ type: "add", item: rect() }]);
    const s = run([{ type: "beginGesture" }, { type: "add", item: line() }, { type: "cancelGesture" }], s0);
    expect(s.items).toBe(s0.items);
    expect(s.selectedId).toBeNull();
    expect(s.past).toHaveLength(1);
  });

  it("cancelGesture outside a gesture does nothing", () => {
    const s0 = run([{ type: "add", item: rect() }]);
    expect(editorReducer(s0, { type: "cancelGesture" })).toBe(s0);
  });

  it("an item added and edited inside one gesture is a single undo step", () => {
    let s = run([{ type: "beginGesture" }, { type: "add", item: rect() }]);
    s = run([{ type: "update", id: "item-1", props: { width: 5 } }, { type: "endGesture" }], s);
    expect(s.past).toHaveLength(1);
    s = editorReducer(s, { type: "undo" });
    expect(s.items).toEqual([]);
  });

  describe("editingId", () => {
    const text = (): NewItem => ({
      kind: "text",
      page: 1,
      rect: [10, 10, 200, 20],
      text: "",
      font: "Helvetica",
      size: 16,
      color: [0, 0, 0],
      opacity: 1,
      align: "left",
      lineHeight: 1.2,
    });

    it("a new text box is in edit mode in the same update that adds it", () => {
      const s = editorReducer(initialEditorState(), { type: "add", item: text() });
      expect(s.editingId).toBe("item-1");
    });

    it("other kinds and duplicates of a text box do not enter edit mode", () => {
      let s = run([{ type: "add", item: rect() }]);
      expect(s.editingId).toBeNull();
      s = run([{ type: "add", item: text() }, { type: "editText", id: null }, { type: "duplicate", id: "item-2" }], s);
      expect(s.editingId).toBeNull();
    });

    it("editText opens an existing text box only, and closes with null", () => {
      let s = run([{ type: "add", item: rect() }, { type: "add", item: text() }, { type: "editText", id: null }]);
      expect(editorReducer(s, { type: "editText", id: "item-1" }).editingId).toBeNull();
      s = editorReducer(s, { type: "editText", id: "item-2" });
      expect(s.editingId).toBe("item-2");
      expect(editorReducer(s, { type: "editText", id: null }).editingId).toBeNull();
    });

    it("edit mode ends when its box goes away (cancelled creation, undo, page switch)", () => {
      let s = run([{ type: "beginGesture" }, { type: "add", item: text() }, { type: "cancelGesture" }]);
      expect(s.editingId).toBeNull();
      s = run([{ type: "add", item: text() }]);
      expect(editorReducer(s, { type: "undo" }).editingId).toBeNull();
      expect(editorReducer(s, { type: "setPage", page: 2 }).editingId).toBeNull();
      expect(editorReducer(s, { type: "delete", id: s.editingId ?? "" }).editingId).toBeNull();
    });
  });

  it("fits a text box to its engine layout without an undo step of its own", () => {
    let s = editorReducer(initialEditorState(), {
      type: "add",
      item: { kind: "text", page: 1, rect: [10, 700, 100, 20], text: "مرحبا", font: "Helvetica", size: 12, color: [0, 0, 0], opacity: 1, align: "auto", lineHeight: 1.2 },
    });
    const id = s.items[0].id;
    const past = s.past.length;
    s = editorReducer(s, { type: "fit", id, height: 50 });
    const rect = (s.items[0] as { rect: number[] }).rect;
    expect(rect[3]).toBeCloseTo(50.001);
    // Top edge kept.
    expect(rect[1] + rect[3]).toBeCloseTo(720);
    expect(s.past.length).toBe(past);
    // Never shrinks.
    expect(editorReducer(s, { type: "fit", id, height: 10 })).toBe(s);
  });
});
