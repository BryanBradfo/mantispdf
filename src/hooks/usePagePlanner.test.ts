import { describe, it, expect } from "vitest";
import { buildPlan, initialPlannerState, plannerReducer, type PlannerAction, type PlannerSource, type PlannerState } from "./usePagePlanner";

const src = (id: string, numPages: number): PlannerSource => ({
  id, numPages, file: new File([], `${id}.pdf`), bytes: new Uint8Array([id.charCodeAt(0)]),
});
const run = (...actions: PlannerAction[]): PlannerState => actions.reduce(plannerReducer, initialPlannerState);
const ids = (s: PlannerState) => s.items.map((i) => i.id);

describe("plannerReducer", () => {
  it("adds one item per page with unique ids, across sources", () => {
    const s = run({ type: "sources-added", sources: [src("a", 2)] }, { type: "sources-added", sources: [src("b", 1)] });
    expect(s.items.map((i) => (i.kind === "page" ? `${i.srcId}${i.page}` : "blank"))).toEqual(["a1", "a2", "b1"]);
    expect(new Set(ids(s)).size).toBe(3);
  });

  it("reorders, duplicates right after, rotates with wrap, inserts blanks", () => {
    let s = run({ type: "sources-added", sources: [src("a", 3)] });
    const [p1, p2, p3] = ids(s);
    s = plannerReducer(s, { type: "reorder", from: 0, to: 2 });
    expect(ids(s)).toEqual([p2, p3, p1]);
    s = plannerReducer(s, { type: "duplicate-item", id: p3 });
    expect(s.items).toHaveLength(4);
    expect(s.items[2]).toMatchObject({ kind: "page", srcId: "a", page: 3 });
    expect(s.items[2].id).not.toBe(p3);
    s = plannerReducer(s, { type: "rotate-item", id: p1, delta: -90 });
    expect(s.items.find((i) => i.id === p1)).toMatchObject({ rotate: 270 });
    s = plannerReducer(s, { type: "rotate-item", id: p1, delta: 90 });
    expect(s.items.find((i) => i.id === p1)).toMatchObject({ rotate: 0 });
    s = plannerReducer(s, { type: "insert-blank", index: 0 });
    expect(s.items[0].kind).toBe("blank");
    s = plannerReducer(s, { type: "insert-blank", index: s.items.length });
    expect(s.items[s.items.length - 1].kind).toBe("blank");
  });

  it("removing an item also deselects it", () => {
    let s = run({ type: "sources-added", sources: [src("a", 2)] });
    const [p1] = ids(s);
    s = plannerReducer(s, { type: "toggle-select", id: p1 });
    s = plannerReducer(s, { type: "remove-item", id: p1 });
    expect(s.selected.has(p1)).toBe(false);
    expect(s.items).toHaveLength(1);
  });

  it("set-selection ignores unknown ids; toggle flips", () => {
    let s = run({ type: "sources-added", sources: [src("a", 2)] });
    const [p1, p2] = ids(s);
    s = plannerReducer(s, { type: "set-selection", ids: [p2, "nope"] });
    expect([...s.selected]).toEqual([p2]);
    s = plannerReducer(s, { type: "toggle-select", id: p1 });
    s = plannerReducer(s, { type: "toggle-select", id: p2 });
    expect([...s.selected]).toEqual([p1]);
  });

  it("ignores out-of-range reorder and unknown ids", () => {
    const s = run({ type: "sources-added", sources: [src("a", 2)] });
    expect(plannerReducer(s, { type: "reorder", from: 5, to: 0 })).toBe(s);
    expect(plannerReducer(s, { type: "remove-item", id: "zzz" }).items).toEqual(s.items);
  });
});

describe("buildPlan", () => {
  const base = () => run(
    { type: "sources-added", sources: [src("a", 3)] },
    { type: "sources-added", sources: [src("b", 1)] },
  );

  it("organize: grid order, compacted sources, blanks", () => {
    let s = base();
    // drop all of source a except page 2, then put a blank first
    const [a1, , a3] = ids(s);
    s = plannerReducer(s, { type: "remove-item", id: a1 });
    s = plannerReducer(s, { type: "remove-item", id: a3 });
    s = plannerReducer(s, { type: "insert-blank", index: 0 });
    s = plannerReducer(s, { type: "rotate-item", id: s.items[2].id, delta: 90 }); // b1
    const { buffers, entries } = buildPlan(s, "organize");
    expect(buffers).toHaveLength(2);
    expect(entries).toEqual([
      { kind: "blank" },
      { kind: "page", src: 0, page: 2, rotate: 0 },
      { kind: "page", src: 1, page: 1, rotate: 90 },
    ]);
  });

  it("organize: unused sources are not sent", () => {
    let s = base();
    s = plannerReducer(s, { type: "remove-item", id: ids(s)[3] }); // b1
    expect(buildPlan(s, "organize").buffers).toHaveLength(1);
  });

  it("remove: everything except selected; extract: only selected", () => {
    let s = run({ type: "sources-added", sources: [src("a", 4)] });
    const [p1, , p3] = ids(s);
    s = plannerReducer(s, { type: "set-selection", ids: [p1, p3] });
    expect(buildPlan(s, "remove").entries.map((e) => (e.kind === "page" ? e.page : 0))).toEqual([2, 4]);
    expect(buildPlan(s, "extract").entries.map((e) => (e.kind === "page" ? e.page : 0))).toEqual([1, 3]);
  });

  it("empty results produce no entries", () => {
    const s = run({ type: "sources-added", sources: [src("a", 1)] });
    expect(buildPlan(s, "extract").entries).toEqual([]);
    const all = plannerReducer(s, { type: "set-selection", ids: ids(s) });
    expect(buildPlan(all, "remove").entries).toEqual([]);
  });
});
