import type { PdfPart } from "../types/pdf";

/** Correlates a request with its response/progress/failure messages. */
export type ReqId = number;

// Main → Worker messages. Every operation carries a unique `id` so responses can
// be matched back to the exact request that produced them (see PdfWorkerClient).
export type ToWorker =
  | { type: "init" }
  | { type: "split"; id: ReqId; pdfBytes: ArrayBuffer; splitAfterPages: number[] }
  | { type: "merge"; id: ReqId; pdfBuffers: Uint8Array[] }
  | { type: "count-pages"; id: ReqId; pdfBytes: Uint8Array }
  | { type: "compress"; id: ReqId; pdfBytes: ArrayBuffer }
  | { type: "rotate"; id: ReqId; pdfBytes: ArrayBuffer; rotations: number[] }
  | { type: "edit-pages"; id: ReqId; pdfBytes: Uint8Array; newOrder: number[] }
  | {
      type: "watermark";
      id: ReqId;
      pdfBytes: ArrayBuffer;
      text: string;
      fontSize: number;
      opacity: number;
      angle: number;
      r: number;
      g: number;
      b: number;
    }
  | { type: "encrypt"; id: ReqId; pdfBytes: ArrayBuffer; userPassword: string; ownerPassword: string };

// The successful result of an operation, tagged by `kind` so the requesting side
// can extract the right field with a runtime check (no unsafe casts).
export type SuccessPayload =
  | { kind: "split"; parts: PdfPart[] }
  | { kind: "merge"; bytes: Uint8Array }
  | { kind: "count"; count: number }
  | { kind: "buffer"; result: ArrayBuffer };

// Worker → Main messages. `init-done`/`init-error` are the one-time handshake;
// all operation responses carry the originating `id`.
export type FromWorker =
  | { type: "init-done" }
  | { type: "init-error"; error: string }
  | { type: "progress"; id: ReqId; progress: number; message: string }
  | { type: "success"; id: ReqId; payload: SuccessPayload }
  | { type: "failure"; id: ReqId; error: string };
