import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FromWorker, SuccessPayload, ToWorker } from "../lib/workerProtocol";
import type { PdfPart } from "../types/pdf";
import { readFileAsArrayBuffer } from "../lib/fileHelpers";
import type { ExtractResultSpec, ImageInputSpec, ImageLayoutSpec } from "../lib/imageInput";
import { editJobTransferables, type EditJobSpec } from "../lib/editor/toJob";
import type { CropJobSpec, NupJobSpec, ResizeJobSpec } from "../lib/geometryJob";
import type { StampJobSpec } from "../lib/stampJob";
import type { FormInfo } from "../lib/forms/model";
import type { FormWireEntry } from "../lib/forms/toWire";
import type { PageStatusWire, RedactJobWire, RedactRectWire, RedactResultWire, RedactSearchWire, SearchOptionsWire } from "../lib/redact/toJob";
import { PdfWorkerClient } from "../lib/workerClient";

export interface SanitizeReport {
  linksKept: number;
  linksDropped: number;
  commentsKept: number;
  commentsDropped: number;
  fieldsFlattened: number;
  /** Every page warning, including the deep-content ones. */
  warnings: number;
  /** Pages where deeply nested content could not be copied. */
  deepContentDropped: number;
  /** JPEG images whose metadata (Exif/GPS, XMP, MPF, trailers) was removed. */
  imagesCleaned: number;
}

export interface PdfMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
}

interface WorkerState {
  ready: boolean;
  initError: string | null;
  splitting: boolean;
  merging: boolean;
  compressing: boolean;
  rotating: boolean;
  watermarking: boolean;
  encrypting: boolean;
  progress: number;
  progressMessage: string;
}

type BusyFlag = "splitting" | "merging" | "compressing" | "rotating" | "watermarking" | "encrypting";

const initialState: WorkerState = {
  ready: false,
  initError: null,
  splitting: false,
  merging: false,
  compressing: false,
  rotating: false,
  watermarking: false,
  encrypting: false,
  progress: 0,
  progressMessage: "",
};

// Payload extractors with a runtime kind-check (no unsafe casts).
const asParts = (p: SuccessPayload): PdfPart[] => {
  if (p.kind !== "split") throw new Error("Unexpected worker payload");
  return p.parts;
};
const asBytes = (p: SuccessPayload): Uint8Array => {
  if (p.kind !== "merge") throw new Error("Unexpected worker payload");
  return p.bytes;
};
const asCount = (p: SuccessPayload): number => {
  if (p.kind !== "count") throw new Error("Unexpected worker payload");
  return p.count;
};
const asBuffer = (p: SuccessPayload): ArrayBuffer => {
  if (p.kind !== "buffer") throw new Error("Unexpected worker payload");
  return p.result;
};

const asNup = (p: SuccessPayload): { bytes: Uint8Array; sheets: number; undecodable: number[] } => {
  if (p.kind !== "nup") throw new Error("Unexpected worker payload");
  return { bytes: p.bytes, sheets: p.sheets, undecodable: p.undecodable };
};

const asExtracted = (p: SuccessPayload): ExtractResultSpec => {
  if (p.kind !== "extracted") throw new Error("Unexpected worker payload");
  return p.result;
};

const asStamped = (p: SuccessPayload): { bytes: Uint8Array; stampedPages: number } => {
  if (p.kind !== "stamped") throw new Error("Unexpected worker payload");
  return { bytes: p.bytes, stampedPages: p.stampedPages };
};

const asSizes = (p: SuccessPayload): [number, number][] => {
  if (p.kind !== "sizes") throw new Error("Unexpected worker payload");
  return p.sizes;
};

const asSanitized = (p: SuccessPayload): { bytes: Uint8Array; report: SanitizeReport } => {
  if (p.kind !== "sanitized") throw new Error("Unexpected worker payload");
  const [
    linksKept = 0,
    linksDropped = 0,
    commentsKept = 0,
    commentsDropped = 0,
    fieldsFlattened = 0,
    warnings = 0,
    deepContentDropped = 0,
    imagesCleaned = 0,
  ] = p.report;
  return {
    bytes: p.bytes,
    report: { linksKept, linksDropped, commentsKept, commentsDropped, fieldsFlattened, warnings, deepContentDropped, imagesCleaned },
  };
};
const asForm = (p: SuccessPayload): FormInfo => {
  if (p.kind !== "form") throw new Error("Unexpected worker payload");
  return p.info;
};
const asRedactPlan = (p: SuccessPayload): PageStatusWire[] => {
  if (p.kind !== "redact-plan") throw new Error("Unexpected worker payload");
  return p.pages;
};
const asRedacted = (p: SuccessPayload): RedactResultWire => {
  if (p.kind !== "redacted") throw new Error("Unexpected worker payload");
  return p.result;
};
const asRedactSearch = (p: SuccessPayload): RedactSearchWire => {
  if (p.kind !== "redact-search") throw new Error("Unexpected worker payload");
  return p.result;
};
const asMetadata = (p: SuccessPayload): PdfMetadata => {
  if (p.kind !== "metadata") throw new Error("Unexpected worker payload");
  const [title = "", author = "", subject = "", keywords = ""] = p.values;
  return { title, author, subject, keywords };
};

export function usePdfWorker() {
  const workerRef = useRef<Worker | null>(null);
  const clientRef = useRef<PdfWorkerClient | null>(null);
  const [state, setState] = useState<WorkerState>(initialState);

  const setFlag = useCallback((flag: BusyFlag, value: boolean) => {
    setState((s) => ({ ...s, [flag]: value }));
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/pdf.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    const client = new PdfWorkerClient((msg, transfer) => {
      worker.postMessage(msg, transfer && transfer.length ? { transfer } : undefined);
    });
    clientRef.current = client;

    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if (msg.type === "init-done") {
        setState((s) => ({ ...s, ready: true }));
        return;
      }
      if (msg.type === "init-error") {
        setState((s) => ({ ...s, initError: msg.error }));
        return;
      }
      client.handleMessage(msg);
    };

    // A worker crash (WASM trap/OOM) or an undeserializable message would
    // otherwise leave every pending operation hanging with no UI feedback (J2).
    const fail = (message: string) => {
      client.handleError(new Error(message));
      setState((s) => ({
        ...s,
        initError: s.ready ? s.initError : message,
        splitting: false,
        merging: false,
        compressing: false,
        rotating: false,
        watermarking: false,
        encrypting: false,
        progress: 0,
        progressMessage: "",
      }));
    };
    worker.onerror = (e) => fail(e.message || "PDF engine crashed");
    worker.onmessageerror = () => fail("PDF engine sent an unreadable message");

    worker.postMessage({ type: "init" } satisfies ToWorker);

    return () => {
      client.handleError(new Error("Worker terminated"));
      worker.terminate();
    };
  }, []);

  // Shared request runner: toggles a busy flag around the client request.
  const run = useCallback(
    <T>(
      flag: BusyFlag | null,
      build: (id: number) => ToWorker,
      extract: (p: SuccessPayload) => T,
      options: { transfer?: Transferable[]; trackProgress?: boolean } = {},
    ): Promise<T> => {
      const client = clientRef.current;
      if (!client) return Promise.reject(new Error("Worker not initialized"));
      if (flag) setState((s) => ({ ...s, [flag]: true, progress: 0, progressMessage: "Starting…" }));
      return client
        .request(build, extract, {
          transfer: options.transfer,
          onProgress: options.trackProgress
            ? (progress, message) => setState((s) => ({ ...s, progress, progressMessage: message }))
            : undefined,
        })
        .finally(() => {
          if (flag) setFlag(flag, false);
        });
    },
    [setFlag],
  );

  const splitPdf = useCallback(
    (pdfBytes: ArrayBuffer, splitAfterPages: number[]): Promise<PdfPart[]> =>
      run("splitting", (id) => ({ type: "split", id, pdfBytes, splitAfterPages }), asParts, {
        transfer: [pdfBytes],
        trackProgress: true,
      }),
    [run],
  );

  const mergePdfs = useCallback(
    (pdfBuffers: Uint8Array[]): Promise<Uint8Array> =>
      run("merging", (id) => ({ type: "merge", id, pdfBuffers }), asBytes, { trackProgress: true }),
    [run],
  );

  const countPages = useCallback(
    (pdfBytes: Uint8Array): Promise<number> =>
      run(null, (id) => ({ type: "count-pages", id, pdfBytes }), asCount),
    [run],
  );

  const compressPdf = useCallback(
    async (file: File): Promise<ArrayBuffer> => {
      const pdfBytes = await readFileAsArrayBuffer(file);
      return run("compressing", (id) => ({ type: "compress", id, pdfBytes }), asBuffer, { transfer: [pdfBytes] });
    },
    [run],
  );

  const rotatePdf = useCallback(
    async (file: File, rotations: number[]): Promise<ArrayBuffer> => {
      const pdfBytes = await readFileAsArrayBuffer(file);
      return run("rotating", (id) => ({ type: "rotate", id, pdfBytes, rotations }), asBuffer, { transfer: [pdfBytes] });
    },
    [run],
  );

  const applyPagePlan = useCallback(
    (pdfBuffers: Uint8Array[], plan: Int32Array): Promise<Uint8Array> =>
      run(null, (id) => ({ type: "page-plan", id, pdfBuffers, plan }), asBytes),
    [run],
  );

  const watermarkPdf = useCallback(
    async (
      file: File,
      text: string,
      fontSize: number,
      opacity: number,
      angle: number,
      r: number,
      g: number,
      b: number,
    ): Promise<ArrayBuffer> => {
      const pdfBytes = await readFileAsArrayBuffer(file);
      return run(
        "watermarking",
        (id) => ({ type: "watermark", id, pdfBytes, text, fontSize, opacity, angle, r, g, b }),
        asBuffer,
        { transfer: [pdfBytes] },
      );
    },
    [run],
  );

  const encryptPdf = useCallback(
    async (file: File, userPassword: string, ownerPassword: string): Promise<ArrayBuffer> => {
      const pdfBytes = await readFileAsArrayBuffer(file);
      return run(
        "encrypting",
        (id) => ({ type: "encrypt", id, pdfBytes, userPassword, ownerPassword }),
        asBuffer,
        { transfer: [pdfBytes] },
      );
    },
    [run],
  );

  const sanitizePdf = useCallback(
    (pdfBytes: Uint8Array, keepComments: boolean): Promise<{ bytes: Uint8Array; report: SanitizeReport }> =>
      run(null, (id) => ({ type: "sanitize", id, pdfBytes, keepComments }), asSanitized),
    [run],
  );

  const stampPdf = useCallback(
    (pdfBytes: Uint8Array, job: StampJobSpec): Promise<{ bytes: Uint8Array; stampedPages: number }> =>
      run(null, (id) => ({ type: "stamp", id, pdfBytes, job }), asStamped),
    [run],
  );

  const editPdf = useCallback(
    (pdfBytes: Uint8Array, job: EditJobSpec): Promise<Uint8Array> =>
      // The input PDF stays with the caller; the job's image buffers are built per job and handed over.
      run(null, (id) => ({ type: "edit-pdf", id, pdfBytes, job }), asBytes, { transfer: editJobTransferables(job) }),
    [run],
  );

  /** The form fields of a PDF (engine traversal order; ids are what `fillForm` takes). */
  const listForm = useCallback(
    (pdfBytes: Uint8Array): Promise<FormInfo> => run(null, (id) => ({ type: "list-form", id, pdfBytes }), asForm),
    [run],
  );

  /** The PDF with `values` filled in (only changed fields), flattened when asked. */
  const fillForm = useCallback(
    (pdfBytes: Uint8Array, values: FormWireEntry[], flatten: boolean): Promise<Uint8Array> =>
      run(null, (id) => ({ type: "fill-form", id, pdfBytes, values, flatten }), asBytes),
    [run],
  );

  /** Every match of `query` as visible-space rects (the exact glyph boxes the engine removes). */
  const redactSearch = useCallback(
    (pdfBytes: Uint8Array, query: string, options: SearchOptionsWire): Promise<RedactSearchWire> =>
      run(null, (id) => ({ type: "redact-search", id, pdfBytes, query, options }), asRedactSearch),
    [run],
  );

  /** Which pages with marks need a raster (`reason` set) before `redactPdf`. */
  const redactPlan = useCallback(
    (pdfBytes: Uint8Array, rects: RedactRectWire[]): Promise<PageStatusWire[]> =>
      run(null, (id) => ({ type: "redact-plan", id, pdfBytes, rects }), asRedactPlan),
    [run],
  );

  /**
   * Redact `job`. The rasters' pixel buffers are transferred to the worker, not copied: after the
   * call they are detached (empty) on this side, so a retry must render the rasters again.
   */
  const redactPdf = useCallback(
    (pdfBytes: Uint8Array, job: RedactJobWire): Promise<RedactResultWire> =>
      run(null, (id) => ({ type: "redact", id, pdfBytes, job }), asRedacted, {
        transfer: job.rasters.map((r) => r.rgba.buffer as ArrayBuffer),
      }),
    [run],
  );

  const cropPdf = useCallback(
    (pdfBytes: Uint8Array, job: CropJobSpec): Promise<Uint8Array> =>
      run(null, (id) => ({ type: "crop", id, pdfBytes, job }), asBytes),
    [run],
  );

  const resizePdf = useCallback(
    (pdfBytes: Uint8Array, job: ResizeJobSpec): Promise<Uint8Array> =>
      run(null, (id) => ({ type: "resize", id, pdfBytes, job }), asBytes),
    [run],
  );

  const nupPdf = useCallback(
    (pdfBytes: Uint8Array, job: NupJobSpec): Promise<{ bytes: Uint8Array; sheets: number; undecodable: number[] }> =>
      run(null, (id) => ({ type: "nup", id, pdfBytes, job }), asNup),
    [run],
  );

  const imagesToPdf = useCallback(
    (images: ImageInputSpec[], layout: ImageLayoutSpec): Promise<Uint8Array> =>
      run(null, (id) => ({ type: "images-to-pdf", id, images, layout }), asBytes, {
        // Hand the buffers over instead of cloning them: callers build them per job.
        transfer: [
          ...new Set(
            images.map((im) => (im.kind === "jpeg" ? im.bytes.buffer : im.pixels.buffer)).filter((b): b is ArrayBuffer => b instanceof ArrayBuffer),
          ),
        ],
      }),
    [run],
  );

  const extractImages = useCallback(
    (pdfBytes: Uint8Array): Promise<ExtractResultSpec> =>
      run(null, (id) => ({ type: "extract-images", id, pdfBytes }), asExtracted),
    [run],
  );

  const removeMetadata = useCallback(
    (pdfBytes: Uint8Array): Promise<Uint8Array> =>
      run(null, (id) => ({ type: "remove-metadata", id, pdfBytes }), asBytes),
    [run],
  );

  const readMetadata = useCallback(
    (pdfBytes: Uint8Array): Promise<PdfMetadata> =>
      run(null, (id) => ({ type: "read-metadata", id, pdfBytes }), asMetadata),
    [run],
  );

  const setMetadata = useCallback(
    (pdfBytes: Uint8Array, m: PdfMetadata): Promise<Uint8Array> =>
      run(
        null,
        (id) => ({
          type: "set-metadata",
          id,
          pdfBytes,
          title: m.title,
          author: m.author,
          subject: m.subject,
          keywords: m.keywords,
        }),
        asBytes,
      ),
    [run],
  );

  /** Visible [width, height] in points of every page (CropBox, /Rotate applied). */
  const pageSizes = useCallback(
    (pdfBytes: Uint8Array): Promise<[number, number][]> =>
      run(null, (id) => ({ type: "page-sizes", id, pdfBytes }), asSizes),
    [run],
  );

  const unlockPdf = useCallback(
    (pdfBytes: Uint8Array, password: string): Promise<Uint8Array> =>
      run(null, (id) => ({ type: "unlock", id, pdfBytes, password }), asBytes),
    [run],
  );

  return useMemo(
    () => ({
      ...state,
      splitPdf,
      mergePdfs,
      countPages,
      compressPdf,
      rotatePdf,
      applyPagePlan,
      watermarkPdf,
      encryptPdf,
      sanitizePdf,
      stampPdf,
      editPdf,
      listForm,
      fillForm,
      redactSearch,
      redactPlan,
      redactPdf,
      cropPdf,
      resizePdf,
      nupPdf,
      imagesToPdf,
      extractImages,
      pageSizes,
      removeMetadata,
      readMetadata,
      setMetadata,
      unlockPdf,
    }),
    [
      state,
      splitPdf,
      mergePdfs,
      countPages,
      compressPdf,
      rotatePdf,
      applyPagePlan,
      watermarkPdf,
      encryptPdf,
      sanitizePdf,
      stampPdf,
      editPdf,
      listForm,
      fillForm,
      redactSearch,
      redactPlan,
      redactPdf,
      cropPdf,
      resizePdf,
      nupPdf,
      imagesToPdf,
      extractImages,
      pageSizes,
      removeMetadata,
      readMetadata,
      setMetadata,
      unlockPdf,
    ],
  );
}
