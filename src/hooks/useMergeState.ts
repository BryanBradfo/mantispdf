import { useReducer } from "react";

export interface MergeFile {
  id: string;
  file: File;
  bytes: Uint8Array;
  numPages: number;
}

interface MergeState {
  files: MergeFile[];
  uploadError: string | null;
}

type MergeAction =
  | { type: "files-added"; files: MergeFile[] }
  | { type: "remove-file"; id: string }
  | { type: "reorder"; fromIndex: number; toIndex: number }
  | { type: "reset" }
  | { type: "upload-error"; error: string };

function mergeReducer(state: MergeState, action: MergeAction): MergeState {
  switch (action.type) {
    case "files-added":
      return { ...state, files: [...state.files, ...action.files], uploadError: null };
    case "remove-file":
      return { ...state, files: state.files.filter((f) => f.id !== action.id) };
    case "reorder": {
      const files = [...state.files];
      const [moved] = files.splice(action.fromIndex, 1);
      files.splice(action.toIndex, 0, moved);
      return { ...state, files };
    }
    case "reset":
      return { files: [], uploadError: null };
    case "upload-error":
      return { ...state, uploadError: action.error };
  }
}

const initialState: MergeState = { files: [], uploadError: null };

export function useMergeState() {
  return useReducer(mergeReducer, initialState);
}
