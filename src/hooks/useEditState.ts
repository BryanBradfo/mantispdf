import { useReducer } from "react";

export type EditState = {
  file: File | null;
  pdfBytes: Uint8Array | null;
  numPages: number;
  pageOrder: number[];       // current order of original 1-indexed page numbers
  deletedPages: Set<number>; // original page numbers marked for deletion
  uploadError: string | null;
};

type EditAction =
  | { type: "file-loaded"; file: File; pdfBytes: Uint8Array; numPages: number }
  | { type: "upload-error"; message: string }
  | { type: "toggle-delete"; page: number }
  | { type: "move-page"; index: number; direction: "left" | "right" }
  | { type: "reset" };

const initialState: EditState = {
  file: null,
  pdfBytes: null,
  numPages: 0,
  pageOrder: [],
  deletedPages: new Set(),
  uploadError: null,
};

function editReducer(state: EditState, action: EditAction): EditState {
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
    case "reset":
      return initialState;
  }
}

export function useEditState() {
  const [state, dispatch] = useReducer(editReducer, initialState);
  return { state, dispatch };
}
