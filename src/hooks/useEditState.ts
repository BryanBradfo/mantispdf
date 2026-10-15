import { useReducer } from "react";

export type EditState = {
  file: File | null;
  pdfBytes: Uint8Array | null;
  numPages: number;
  pageOrder: number[];       // current order of original 1-indexed page numbers
  deletedPages: Set<number>; // original page numbers marked for deletion
  uploadError: string | null;
};

export type EditAction =
  | { type: "file-loaded"; file: File; pdfBytes: Uint8Array; numPages: number }
  | { type: "upload-error"; message: string }
  | { type: "toggle-delete"; page: number }
  | { type: "move-page"; index: number; direction: "left" | "right" }
  | { type: "reorder"; from: number; to: number }
  | { type: "reset" };

const initialState: EditState = {
  file: null,
  pdfBytes: null,
  numPages: 0,
  pageOrder: [],
  deletedPages: new Set(),
  uploadError: null,
};

export function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "file-loaded":
      return {
        ...state,
        file: action.file,
        pdfBytes: action.pdfBytes,
        numPages: action.numPages,
        pageOrder: Array.from({ length: action.numPages }, (_, i) => i + 1),
        deletedPages: new Set(),
        uploadError: null,
      };
    case "upload-error":
      return { ...state, uploadError: action.message };
    case "toggle-delete": {
      const next = new Set(state.deletedPages);
      if (next.has(action.page)) {
        next.delete(action.page);
      } else {
        next.add(action.page);
      }
      return { ...state, deletedPages: next };
    }
    case "move-page": {
      const order = [...state.pageOrder];
      const { index, direction } = action;
      const swapIdx = direction === "left" ? index - 1 : index + 1;
      if (swapIdx < 0 || swapIdx >= order.length) return state;
      [order[index], order[swapIdx]] = [order[swapIdx], order[index]];
      return { ...state, pageOrder: order };
    }
    case "reorder": {
      const { from, to } = action;
      const n = state.pageOrder.length;
      if (from < 0 || from >= n || to < 0 || to >= n || from === to) return state;
      const order = [...state.pageOrder];
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      return { ...state, pageOrder: order };
    }
    case "reset":
      return initialState;
  }
}

export function useEditState() {
  const [state, dispatch] = useReducer(editReducer, initialState);
  return { state, dispatch };
}
