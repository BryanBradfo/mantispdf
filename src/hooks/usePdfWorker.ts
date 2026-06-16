import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FromWorker, SuccessPayload, ToWorker } from "../lib/workerProtocol";
import type { PdfPart } from "../types/pdf";
import { readFileAsArrayBuffer } from "../lib/fileHelpers";
import { PdfWorkerClient } from "../lib/workerClient";

interface WorkerState {
  ready: boolean;
  initError: string | null;
  splitting: boolean;
  merging: boolean;
  compressing: boolean;
  rotating: boolean;
  editing: boolean;
  watermarking: boolean;
  encrypting: boolean;
  progress: number;
  progressMessage: string;
}

type BusyFlag = "splitting" | "merging" | "compressing" | "rotating" | "editing" | "watermarking" | "encrypting";

const initialState: WorkerState = {
  ready: false,
  initError: null,
  splitting: false,
  merging: false,
  compressing: false,
  rotating: false,
  editing: false,
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
        editing: false,
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

  const editPages = useCallback(
    (pdfBytes: Uint8Array, newOrder: number[]): Promise<ArrayBuffer> =>
      // Not transferred: pdfBytes is held in React state and reused on re-download.
      run("editing", (id) => ({ type: "edit-pages", id, pdfBytes, newOrder }), asBuffer),
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

  return useMemo(
    () => ({ ...state, splitPdf, mergePdfs, countPages, compressPdf, rotatePdf, editPages, watermarkPdf, encryptPdf }),
    [state, splitPdf, mergePdfs, countPages, compressPdf, rotatePdf, editPages, watermarkPdf, encryptPdf],
  );
}
