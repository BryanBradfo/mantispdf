/**
 * Editor reducer with undo/redo. Every committed change pushes the previous `items` snapshot on
 * `past` (at most `HISTORY_LIMIT`). Between `beginGesture` and `endGesture` (a pointer drag),
 * changes are applied live but committed as a single undo step when the gesture ends, or dropped
 * altogether by `cancelGesture`.
 */
import { resizeItem, translateItem, type Handle } from "./geometry";
import { HISTORY_LIMIT, type EditorState, type Item, type ItemPatch, type NewItem, type Point } from "./model";

/** Offset of a duplicate from its original, in points (right and down on the page). */
export const DUPLICATE_OFFSET = 10;

export type EditorAction =
  | { type: "add"; item: NewItem }
  | { type: "update"; id: string; props: ItemPatch }
  | { type: "move"; id: string; dx: number; dy: number }
  | { type: "resize"; id: string; handle: Handle; point: Point; keepAspect: boolean }
  | { type: "delete"; id?: string }
  | { type: "duplicate"; id?: string }
  | { type: "forward"; id?: string }
  | { type: "backward"; id?: string }
  | { type: "select"; id: string | null }
  | { type: "setPage"; page: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "beginGesture" }
  | { type: "endGesture" }
  | { type: "cancelGesture" };

/** Apply a change to `items`; outside a gesture it becomes one undo step. */
function commit(state: EditorState, items: Item[], extra: Partial<EditorState> = {}): EditorState {
  if (state.gestureBase !== null) return { ...state, ...extra, items };
  const past = [...state.past, state.items];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { ...state, ...extra, items, past, future: [] };
}

function replaceItem(state: EditorState, id: string, f: (it: Item) => Item): EditorState {
  const index = state.items.findIndex((it) => it.id === id);
  if (index < 0) return state;
  const next = f(state.items[index]);
  if (next === state.items[index]) return state;
  const items = state.items.slice();
  items[index] = next;
  return commit(state, items);
}

/** Merge only the keys the item already has, so a patch can never change its kind or id. */
function mergeProps(item: Item, props: ItemPatch): Item {
  const target = item as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...target };
  let changed = false;
  for (const [key, value] of Object.entries(props)) {
    if (key === "id" || key === "kind" || !(key in target) || value === undefined) continue;
    if (merged[key] !== value) {
      merged[key] = value;
      changed = true;
    }
  }
  return changed ? (merged as unknown as Item) : item;
}

/** Page of the first item that differs between two snapshots (by id and identity). */
function changedPage(a: readonly Item[], b: readonly Item[]): number | null {
  const byId = new Map(b.map((it) => [it.id, it]));
  for (const it of a) {
    if (byId.get(it.id) !== it) return it.page;
  }
  const ids = new Set(a.map((it) => it.id));
  for (const it of b) {
    if (!ids.has(it.id)) return it.page;
  }
  // Same items, different order (z-order change).
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i].page;
  return null;
}

/**
 * Swap to `items` from history: the editor follows the change to its page so an undo is never
 * invisible, an item that comes back is selected, and a selection whose item no longer exists
 * is cleared.
 */
function restore(state: EditorState, items: Item[], past: Item[][], future: Item[][]): EditorState {
  const page = changedPage(state.items, items) ?? state.page;
  // An item brought back (undo of a delete, redo of an add) is selected so it can be acted on.
  const current = new Set(state.items.map((it) => it.id));
  const restored = items.find((it) => !current.has(it.id) && it.page === page);
  const kept =
    page === state.page && state.selectedId !== null && items.some((it) => it.id === state.selectedId)
      ? state.selectedId
      : null;
  const selectedId = restored ? restored.id : kept;
  return { ...state, items, past, future, page, selectedId, gestureBase: null };
}

/** Close an open gesture: one undo step if anything changed, none otherwise. */
function endGesture(state: EditorState): EditorState {
  const base = state.gestureBase;
  if (base === null) return state;
  if (base === state.items) return { ...state, gestureBase: null };
  const past = [...state.past, base];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { ...state, past, future: [], gestureBase: null };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "add": {
      const id = `item-${state.nextId}`;
      const item = { ...action.item, id } as Item;
      return commit(state, [...state.items, item], { selectedId: id, nextId: state.nextId + 1 });
    }
    case "update":
      return replaceItem(state, action.id, (it) => mergeProps(it, action.props));
    case "move":
      if (action.dx === 0 && action.dy === 0) return state;
      return replaceItem(state, action.id, (it) => translateItem(it, action.dx, action.dy));
    case "resize":
      return replaceItem(state, action.id, (it) => resizeItem(it, action.handle, action.point, action.keepAspect));
    case "delete": {
      const id = action.id ?? state.selectedId;
      if (id === null || !state.items.some((it) => it.id === id)) return state;
      const items = state.items.filter((it) => it.id !== id);
      return commit(state, items, { selectedId: state.selectedId === id ? null : state.selectedId });
    }
    case "duplicate": {
      const id = action.id ?? state.selectedId;
      const index = state.items.findIndex((it) => it.id === id);
      if (index < 0) return state;
      const newId = `item-${state.nextId}`;
      const copy = { ...translateItem(state.items[index], DUPLICATE_OFFSET, -DUPLICATE_OFFSET), id: newId };
      return commit(state, [...state.items, copy], { selectedId: newId, nextId: state.nextId + 1 });
    }
    case "forward":
    case "backward": {
      const id = action.id ?? state.selectedId;
      const index = state.items.findIndex((it) => it.id === id);
      if (index < 0) return state;
      const page = state.items[index].page;
      const step = action.type === "forward" ? 1 : -1;
      // Swap with the next item on the same page: other pages' order does not matter.
      let other = index + step;
      while (other >= 0 && other < state.items.length && state.items[other].page !== page) other += step;
      if (other < 0 || other >= state.items.length) return state;
      const items = state.items.slice();
      [items[index], items[other]] = [items[other], items[index]];
      return commit(state, items);
    }
    case "select": {
      if (action.id === state.selectedId) return state;
      if (action.id !== null && !state.items.some((it) => it.id === action.id)) return state;
      return { ...state, selectedId: action.id };
    }
    case "setPage": {
      if (action.page === state.page) return state;
      return { ...endGesture(state), page: action.page, selectedId: null };
    }
    case "undo": {
      const s = endGesture(state);
      if (s.past.length === 0) return s;
      const previous = s.past[s.past.length - 1];
      return restore(s, previous, s.past.slice(0, -1), [...s.future, s.items]);
    }
    case "redo": {
      const s = endGesture(state);
      if (s.future.length === 0) return s;
      const next = s.future[s.future.length - 1];
      return restore(s, next, [...s.past, s.items], s.future.slice(0, -1));
    }
    case "beginGesture":
      return state.gestureBase === null ? { ...state, gestureBase: state.items } : state;
    case "endGesture":
      return endGesture(state);
    case "cancelGesture": {
      // Back to the items of the gesture start, as if it never happened (no history entry).
      const base = state.gestureBase;
      if (base === null) return state;
      const selectedId = state.selectedId !== null && base.some((it) => it.id === state.selectedId) ? state.selectedId : null;
      return { ...state, items: base, selectedId, gestureBase: null };
    }
  }
}
