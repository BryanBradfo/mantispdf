import { useReducer } from "react";
import type { PlanEntry } from "../lib/pagePlan";
import type { UiError } from "../i18n";

export interface PlannerSource {
  id: string;
  file: File;
  bytes: Uint8Array;
  numPages: number;
}

export type PlannerItem =
  | { id: string; kind: "page"; srcId: string; page: number; rotate: number }
  | { id: string; kind: "blank" };

export interface PlannerState {
  sources: PlannerSource[];
  items: PlannerItem[];
  selected: ReadonlySet<string>;
  /** Counter for item ids; kept in state so the reducer stays pure. */
  nextId: number;
  uploadError: UiError | null;
}

export type PlannerAction =
  | { type: "sources-added"; sources: PlannerSource[] }
  | { type: "upload-error"; message: UiError }
  | { type: "reorder"; from: number; to: number }
  | { type: "remove-item"; id: string }
  | { type: "duplicate-item"; id: string }
  | { type: "rotate-item"; id: string; delta: 90 | -90 }
  | { type: "insert-blank"; index: number }
  | { type: "toggle-select"; id: string }
  | { type: "set-selection"; ids: readonly string[] }
  | { type: "reset" };

export const initialPlannerState: PlannerState = {
  sources: [],
  items: [],
  selected: new Set(),
  nextId: 1,
  uploadError: null,
};

const wrap = (deg: number) => ((deg % 360) + 360) % 360;

export function plannerReducer(state: PlannerState, action: PlannerAction): PlannerState {
  switch (action.type) {
    case "sources-added": {
      let nextId = state.nextId;
      const items: PlannerItem[] = [...state.items];
      for (const source of action.sources) {
        for (let page = 1; page <= source.numPages; page++) {
          items.push({ id: `i${nextId++}`, kind: "page", srcId: source.id, page, rotate: 0 });
        }
      }
      return { ...state, sources: [...state.sources, ...action.sources], items, nextId, uploadError: null };
    }
    case "upload-error":
      return { ...state, uploadError: action.message };
    case "reorder": {
      const { from, to } = action;
      const n = state.items.length;
      if (from < 0 || from >= n || to < 0 || to >= n || from === to) return state;
      const items = [...state.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      return { ...state, items };
    }
    case "remove-item": {
      const selected = new Set(state.selected);
      selected.delete(action.id);
      return { ...state, items: state.items.filter((i) => i.id !== action.id), selected };
    }
    case "duplicate-item": {
      const index = state.items.findIndex((i) => i.id === action.id);
      if (index === -1) return state;
      const items = [...state.items];
      items.splice(index + 1, 0, { ...state.items[index], id: `i${state.nextId}` });
      return { ...state, items, nextId: state.nextId + 1 };
    }
    case "rotate-item":
      return {
        ...state,
        items: state.items.map((i) =>
          i.id === action.id && i.kind === "page" ? { ...i, rotate: wrap(i.rotate + action.delta) } : i,
        ),
      };
    case "insert-blank": {
      const index = Math.max(0, Math.min(action.index, state.items.length));
      const items = [...state.items];
      items.splice(index, 0, { id: `i${state.nextId}`, kind: "blank" });
      return { ...state, items, nextId: state.nextId + 1 };
    }
    case "toggle-select": {
      const selected = new Set(state.selected);
      if (selected.has(action.id)) selected.delete(action.id);
      else selected.add(action.id);
      return { ...state, selected };
    }
    case "set-selection": {
      const known = new Set(state.items.map((i) => i.id));
      return { ...state, selected: new Set(action.ids.filter((id) => known.has(id))) };
    }
    case "reset":
      return initialPlannerState;
  }
}

export type PlannerMode = "organize" | "remove" | "extract";

/** The page plan for `mode`, sending only the sources it actually uses. */
export function buildPlan(state: PlannerState, mode: PlannerMode): { buffers: Uint8Array[]; entries: PlanEntry[] } {
  const kept = state.items.filter((item) =>
    mode === "organize" ? true : mode === "remove" ? !state.selected.has(item.id) : state.selected.has(item.id),
  );
  const srcIndex = new Map<string, number>();
  const buffers: Uint8Array[] = [];
  const entries: PlanEntry[] = [];
  for (const item of kept) {
    if (item.kind === "blank") {
      entries.push({ kind: "blank" });
      continue;
    }
    let src = srcIndex.get(item.srcId);
    if (src === undefined) {
      const source = state.sources.find((s) => s.id === item.srcId);
      if (!source) continue;
      src = buffers.length;
      srcIndex.set(item.srcId, src);
      buffers.push(source.bytes);
    }
    entries.push({ kind: "page", src, page: item.page, rotate: item.rotate });
  }
  if (!entries.some((e) => e.kind === "page")) return { buffers: [], entries: [] };
  return { buffers, entries };
}

export function usePagePlanner() {
  return useReducer(plannerReducer, initialPlannerState);
}
