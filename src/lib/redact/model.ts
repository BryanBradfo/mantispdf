/**
 * Redaction marks: areas drawn on a page, text search matches and whole pages, with undo/redo.
 * Geometry is in visible page space like the editor (points, origin at the bottom-left of the
 * page as displayed, CropBox and /Rotate applied); the engine maps it to the page itself.
 */

/** `[x, y, w, h]` in visible points, `(x, y)` is the bottom-left corner. */
export type Rect = [number, number, number, number];

export type MarkInput =
  | { kind: "area"; page: number; rect: Rect }
  | { kind: "search"; page: number; rect: Rect; query: string }
  | { kind: "page"; page: number };

export type Mark = MarkInput & { id: string };

/** Most marks a job may send (the engine's `MAX_RECTS`). */
export const MAX_MARKS = 10_000;

export interface MarksState {
  marks: Mark[];
  /** Earlier `marks`, most recent last. */
  past: Mark[][];
  /** Undone `marks`, next redo last. */
  future: Mark[][];
  nextId: number;
}

/** Undo steps kept. */
const MAX_HISTORY = 100;

export function initialMarks(): MarksState {
  return { marks: [], past: [], future: [], nextId: 1 };
}

/** A new state with `marks` committed as one undo step (no step when nothing changed). */
function commit(s: MarksState, marks: Mark[], nextId = s.nextId): MarksState {
  if (marks === s.marks) return s;
  return { marks, past: [...s.past, s.marks].slice(-MAX_HISTORY), future: [], nextId };
}

const hasArea = (m: MarkInput) => m.kind === "page" || (m.rect[2] !== 0 && m.rect[3] !== 0);

/** Add marks (areas without width or height are dropped), up to `MAX_MARKS` in all. */
export function addMarks(s: MarksState, inputs: MarkInput[]): MarksState {
  const room = MAX_MARKS - s.marks.length;
  const added = inputs.filter(hasArea).slice(0, Math.max(0, room));
  if (added.length === 0) return s;
  let nextId = s.nextId;
  const marks = [...s.marks, ...added.map((m) => ({ ...m, id: `m${nextId++}` }) as Mark)];
  return commit(s, marks, nextId);
}

export function removeMark(s: MarksState, id: string): MarksState {
  const marks = s.marks.filter((m) => m.id !== id);
  return marks.length === s.marks.length ? s : commit(s, marks);
}

/** Mark the whole page, or unmark it when it already is. */
export function togglePage(s: MarksState, page: number): MarksState {
  const existing = s.marks.find((m) => m.kind === "page" && m.page === page);
  return existing ? removeMark(s, existing.id) : addMarks(s, [{ kind: "page", page }]);
}

export function clearMarks(s: MarksState): MarksState {
  return s.marks.length === 0 ? s : commit(s, []);
}

export const canUndo = (s: MarksState) => s.past.length > 0;
export const canRedo = (s: MarksState) => s.future.length > 0;

export function undo(s: MarksState): MarksState {
  const previous = s.past[s.past.length - 1];
  if (!previous) return s;
  return { ...s, marks: previous, past: s.past.slice(0, -1), future: [...s.future, s.marks] };
}

export function redo(s: MarksState): MarksState {
  const next = s.future[s.future.length - 1];
  if (!next) return s;
  return { ...s, marks: next, past: [...s.past, s.marks], future: s.future.slice(0, -1) };
}
