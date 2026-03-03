import { useReducer } from "react";

interface SplitState {
  file: File | null;
  pdfBytes: Uint8Array | null;
  numPages: number;
  splitPoints: Set<number>; // page numbers after which to split
  uploadError: string | null;
}

type SplitAction =
  | { type: "file-loaded"; file: File; pdfBytes: Uint8Array; numPages: number }
  | { type: "upload-error"; error: string }
  | { type: "toggle-split"; page: number }
  | { type: "reset" };

const initialState: SplitState = {
  file: null,
  pdfBytes: null,
  numPages: 0,
  splitPoints: new Set(),
  uploadError: null,
};

function reducer(state: SplitState, action: SplitAction): SplitState {
  switch (action.type) {
    case "file-loaded":
      return {
        ...initialState,
        file: action.file,
        pdfBytes: action.pdfBytes,
        numPages: action.numPages,
      };
    case "upload-error":
      return { ...initialState, uploadError: action.error };
    case "toggle-split": {
      const next = new Set(state.splitPoints);
      if (next.has(action.page)) {
        next.delete(action.page);
      } else {
        next.add(action.page);
      }
      return { ...state, splitPoints: next };
    }
    case "reset":
      return initialState;
  }
}

export function useSplitState() {
  return useReducer(reducer, initialState);
}
