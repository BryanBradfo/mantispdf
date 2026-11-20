import type { CompareLimits, CompareResult, Word } from "./types";

export type CompareRequest = { type: "compare"; id: number; a: Word[][]; b: Word[][]; limits: CompareLimits };
export type CompareResponse =
  | { type: "success"; id: number; result: CompareResult }
  | { type: "failure"; id: number; error: string };
