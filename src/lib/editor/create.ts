/** Items made by a creation gesture of the editor (a drag, or a click for a default size). */
import { MIN_SIZE, rectFromPoints } from "./geometry";
import type { ImageSource, NewItem, Point, Rect, Rgb } from "./model";
import { textBoxHeight } from "./textFit";

export const BLACK: Rgb = [0, 0, 0];
export const HIGHLIGHT_YELLOW: Rgb = [1, 0.92, 0.23];
export const TEXT_DEFAULTS = { font: "Helvetica", size: 16, lineHeight: 1.2 } as const;

/** Size of an item created by a click (no drag), in points. */
export const CLICK_SIZE: Record<"text" | "rect" | "ellipse" | "highlight" | "whiteout" | "image", [number, number]> = {
  text: [200, textBoxHeight(1, TEXT_DEFAULTS.font, TEXT_DEFAULTS.size, TEXT_DEFAULTS.lineHeight)],
  rect: [120, 80],
  ellipse: [120, 80],
  highlight: [150, 18],
  whiteout: [120, 30],
  image: [150, 150],
};
export const CLICK_LINE_LENGTH = 120;
/** A dragged highlight or text box thinner than this (points) is given its default size. */
export const TINY_DRAG = 4;

export type CreateTool = "text" | "image" | "rect" | "ellipse" | "line" | "arrow" | "highlight" | "whiteout";

export interface CreateGesture {
  tool: CreateTool;
  page: number;
  /** Press and current pointer positions, visible points. */
  start: Point;
  current: Point;
  /** False for a click: the item gets its default size at the press point. */
  dragged: boolean;
  pageSize: [number, number];
  /** The picked image (Image tool). */
  image: ImageSource | null;
}

/** The item a creation gesture makes, or null (Image tool without a picked image). */
export function createItem(g: CreateGesture): NewItem | null {
  const [px, py] = g.start;
  const { page } = g;
  const sized = (kind: keyof typeof CLICK_SIZE): Rect => {
    const [dw, dh] = CLICK_SIZE[kind];
    if (!g.dragged) return [px, py - dh, dw, dh];
    // A drag along one axis has no area, and the engine refuses a box without area: each kind
    // gets a size it can draw.
    const [x, y, w, h] = rectFromPoints(g.start, g.current);
    const top = y + h;
    switch (kind) {
      case "highlight": {
        // A stroke over a line of text: the default height, centred on the drag.
        const nh = h < TINY_DRAG ? dh : h;
        return [x, y + h / 2 - nh / 2, Math.max(w, MIN_SIZE), nh];
      }
      case "text": {
        // At least the default width and one line, hanging from the top edge.
        const nw = w < TINY_DRAG ? dw : w;
        const nh = Math.max(h, dh);
        return [x, top - nh, nw, nh];
      }
      default:
        return [x, y, Math.max(w, MIN_SIZE), Math.max(h, MIN_SIZE)];
    }
  };
  switch (g.tool) {
    case "text":
      return {
        kind: "text",
        page,
        rect: sized("text"),
        text: "",
        font: TEXT_DEFAULTS.font,
        size: TEXT_DEFAULTS.size,
        color: BLACK,
        opacity: 1,
        align: "auto",
        lineHeight: TEXT_DEFAULTS.lineHeight,
      };
    case "rect":
    case "ellipse":
      return { kind: g.tool, page, rect: sized(g.tool), stroke: { kind: "rgb", color: BLACK }, width: 2, fill: { kind: "none" }, opacity: 1 };
    case "highlight":
      return { kind: "highlight", page, rect: sized("highlight"), color: HIGHLIGHT_YELLOW, opacity: 0.4 };
    case "whiteout":
      return { kind: "whiteout", page, rect: sized("whiteout") };
    case "line":
    case "arrow": {
      const to: Point = g.dragged ? g.current : [px + CLICK_LINE_LENGTH, py];
      return { kind: "line", page, from: g.start, to, color: BLACK, width: 2, opacity: 1, arrowStart: false, arrowEnd: g.tool === "arrow" };
    }
    case "image": {
      if (!g.image) return null;
      // Keeps the image aspect: the drag sets the width, the press point is a fixed corner.
      const aspect = g.image.width / g.image.height;
      const w = g.dragged ? Math.max(Math.abs(g.current[0] - px), 4) : Math.min(CLICK_SIZE.image[0], g.pageSize[0]);
      const h = w / aspect;
      const x = g.dragged && g.current[0] < px ? px - w : px;
      const y = g.dragged && g.current[1] > py ? py : py - h;
      return { kind: "image", page, rect: [x, y, w, h], image: g.image, opacity: 1, rotation: 0 };
    }
  }
}
