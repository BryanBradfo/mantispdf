import type { PdfPart } from "../types/pdf";
import type { ImageInputSpec, ImageLayoutSpec, ExtractResultSpec } from "./imageInput";
import type { EditJobSpec } from "./editor/toJob";
import type { CropJobSpec, NupJobSpec, ResizeJobSpec } from "./geometryJob";
import type { StampJobSpec } from "./stampJob";
import type { FormInfo } from "./forms/model";
import type { FormWireEntry } from "./forms/toWire";

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
  | { type: "page-plan"; id: ReqId; pdfBuffers: Uint8Array[]; plan: Int32Array }
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
  | { type: "encrypt"; id: ReqId; pdfBytes: ArrayBuffer; userPassword: string; ownerPassword: string }
  | { type: "sanitize"; id: ReqId; pdfBytes: Uint8Array; keepComments: boolean }
  | { type: "stamp"; id: ReqId; pdfBytes: Uint8Array; job: StampJobSpec }
  | { type: "edit-pdf"; id: ReqId; pdfBytes: Uint8Array; job: EditJobSpec }
  | { type: "crop"; id: ReqId; pdfBytes: Uint8Array; job: CropJobSpec }
  | { type: "resize"; id: ReqId; pdfBytes: Uint8Array; job: ResizeJobSpec }
  | { type: "nup"; id: ReqId; pdfBytes: Uint8Array; job: NupJobSpec }
  | { type: "images-to-pdf"; id: ReqId; images: ImageInputSpec[]; layout: ImageLayoutSpec }
  | { type: "extract-images"; id: ReqId; pdfBytes: Uint8Array }
  | { type: "page-sizes"; id: ReqId; pdfBytes: Uint8Array }
  | { type: "remove-metadata"; id: ReqId; pdfBytes: Uint8Array }
  | { type: "read-metadata"; id: ReqId; pdfBytes: Uint8Array }
  | { type: "set-metadata"; id: ReqId; pdfBytes: Uint8Array; title: string; author: string; subject: string; keywords: string }
  | { type: "unlock"; id: ReqId; pdfBytes: Uint8Array; password: string }
  | { type: "list-form"; id: ReqId; pdfBytes: Uint8Array }
  | { type: "fill-form"; id: ReqId; pdfBytes: Uint8Array; values: FormWireEntry[]; flatten: boolean };

// The successful result of an operation, tagged by `kind` so the requesting side
// can extract the right field with a runtime check (no unsafe casts).
export type SuccessPayload =
  | { kind: "split"; parts: PdfPart[] }
  | { kind: "merge"; bytes: Uint8Array }
  | { kind: "count"; count: number }
  | { kind: "buffer"; result: ArrayBuffer }
  | { kind: "sanitized"; bytes: Uint8Array; report: number[] }
  | { kind: "stamped"; bytes: Uint8Array; stampedPages: number }
  | { kind: "nup"; bytes: Uint8Array; sheets: number; undecodable: number[] }
  | { kind: "extracted"; result: ExtractResultSpec }
  | { kind: "sizes"; sizes: [number, number][] }
  | { kind: "metadata"; values: string[] }
  | { kind: "form"; info: FormInfo };

// Worker → Main messages. `init-done`/`init-error` are the one-time handshake;
// all operation responses carry the originating `id`.
export type FromWorker =
  | { type: "init-done" }
  | { type: "init-error"; error: string }
  | { type: "progress"; id: ReqId; progress: number; message: string }
  | { type: "success"; id: ReqId; payload: SuccessPayload }
  | { type: "failure"; id: ReqId; error: string };
