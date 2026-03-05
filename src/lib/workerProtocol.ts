import type { PdfPart } from "../types/pdf";

// Main → Worker messages
export type ToWorker =
  | { type: "init" }
  | { type: "split"; pdfBytes: Uint8Array; splitAfterPages: number[] }
  | { type: "merge"; pdfBuffers: Uint8Array[] };

// Worker → Main messages
export type FromWorker =
  | { type: "init-done" }
  | { type: "init-error"; error: string }
  | { type: "split-progress"; progress: number; message: string }
  | { type: "split-done"; parts: PdfPart[] }
  | { type: "split-error"; error: string }
  | { type: "merge-progress"; progress: number; message: string }
  | { type: "merge-done"; bytes: Uint8Array }
  | { type: "merge-error"; error: string };
