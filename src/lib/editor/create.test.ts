import { describe, expect, it } from "vitest";
import { MIN_SIZE } from "./geometry";
import { CLICK_SIZE, createItem, type CreateGesture, type CreateTool } from "./create";
import { addError, type Rect } from "./model";

const drag = (tool: CreateTool, start: [number, number], current: [number, number]): CreateGesture => ({
  tool,
  page: 1,
  start,
  current,
  dragged: true,
  pageSize: [612, 792],
  image: null,
});

const rectOf = (g: CreateGesture): Rect => {
  const it = createItem(g);
  if (!it || !("rect" in it)) throw new Error("no rect item");
  return it.rect;
};

describe("createItem: a drag along one axis still makes a visible box", () => {
  it("a flat highlight drag gets the default highlight height, centred on the drag line", () => {
    const [x, y, w, h] = rectOf(drag("highlight", [100, 200], [300, 200]));
    expect([x, w]).toEqual([100, 200]);
    expect(h).toBe(CLICK_SIZE.highlight[1]);
    expect(y + h / 2).toBe(200);
  });

  it("a highlight drag thinner than 4 pt is also given the default height", () => {
    const [, y, , h] = rectOf(drag("highlight", [100, 200], [300, 203]));
    expect(h).toBe(CLICK_SIZE.highlight[1]);
    expect(y + h / 2).toBeCloseTo(201.5);
  });

  it("a text box dragged with almost no width gets the default width", () => {
    const [x, , w, h] = rectOf(drag("text", [100, 200], [101, 100]));
    expect(x).toBe(100);
    expect(w).toBe(CLICK_SIZE.text[0]);
    expect(h).toBe(100);
  });

  it("a flat text drag is at least one line tall", () => {
    const [, , , h] = rectOf(drag("text", [100, 200], [300, 200]));
    expect(h).toBe(CLICK_SIZE.text[1]);
  });

  it.each(["rect", "ellipse", "whiteout"] as const)("a %s drag is at least MIN_SIZE on both sides", (tool) => {
    const [, , w1, h1] = rectOf(drag(tool, [100, 200], [300, 200]));
    expect(w1).toBe(200);
    expect(h1).toBe(MIN_SIZE);
    const [, , w2, h2] = rectOf(drag(tool, [100, 200], [100, 50]));
    expect(w2).toBe(MIN_SIZE);
    expect(h2).toBe(150);
  });

  it("every degenerate drag passes the add check", () => {
    for (const tool of ["text", "rect", "ellipse", "highlight", "whiteout"] as const) {
      const item = createItem(drag(tool, [100, 200], [300, 200]));
      expect(item && addError([], item), tool).toBeNull();
    }
  });
});

describe("addError: a box without area is refused (the engine rejects the whole job)", () => {
  it.each([
    [0, 10],
    [10, 0],
    [-1, 10],
    [Number.NaN, 10],
  ])("w=%s h=%s", (w, h) => {
    expect(addError([], { kind: "whiteout", page: 1, rect: [0, 0, w, h] })).toMatch(/no area/);
  });
});
