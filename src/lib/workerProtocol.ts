import type { PdfPart } from "../types/pdf";

// Main → Worker messages
export type ToWorker =
  | { type: "init" }
  | { type: "split"; pdfBytes: Uint8Array; splitAfterPages: number[] }
  | { type: "merge"; pdfBuffers: Uint8Array[] }
  | { type: "count-pages"; pdfBytes: Uint8Array }
  | { type: "compress"; pdfBytes: ArrayBuffer }
  | { type: "rotate"; pdfBytes: ArrayBuffer; rotations: number[] }
  | { type: "edit-pages"; pdfBytes: Uint8Array; newOrder: number[] }
  | { type: "watermark"; pdfBytes: ArrayBuffer; text: string; fontSize: number; opacity: number; angle: number; r: number; g: number; b: number };

// Worker → Main messages
export type FromWorker =
  | { type: "init-done" }
  | { type: "init-error"; error: string }
  | { type: "split-progress"; progress: number; message: string }
  | { type: "split-done"; parts: PdfPart[] }
  | { type: "split-error"; error: string }
  | { type: "merge-progress"; progress: number; message: string }
  | { type: "merge-done"; bytes: Uint8Array }
  | { type: "merge-error"; error: string }
  | { type: "count-done"; count: number }
  | { type: "count-error"; error: string }
  | { type: "compress-done"; result: ArrayBuffer }
  | { type: "compress-error"; error: string }
  | { type: "rotate-done"; result: ArrayBuffer }
  | { type: "rotate-error"; error: string }
  | { type: "edit-done"; result: ArrayBuffer }
  | { type: "edit-error"; message: string }
  | { type: "watermark-done"; result: ArrayBuffer }
  | { type: "watermark-error"; error: string };
