import type { PdfPart } from "../types/pdf";

// Main → Worker messages
export type ToWorker =
  | { type: "init" }
  | { type: "split"; pdfBytes: Uint8Array; splitAfterPages: number[] };

// Worker → Main messages
export type FromWorker =
  | { type: "init-done" }
  | { type: "init-error"; error: string }
  | { type: "split-progress"; progress: number; message: string }
  | { type: "split-done"; parts: PdfPart[] }
  | { type: "split-error"; error: string };
