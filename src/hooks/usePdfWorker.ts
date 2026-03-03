import { useEffect, useRef, useState, useCallback } from "react";
import type { ToWorker, FromWorker } from "../lib/workerProtocol";
import type { PdfPart } from "../types/pdf";

interface WorkerState {
  ready: boolean;
  initError: string | null;
  splitting: boolean;
  progress: number;
  progressMessage: string;
}

export function usePdfWorker() {
  const workerRef = useRef<Worker | null>(null);
  const resolveRef = useRef<((parts: PdfPart[]) => void) | null>(null);
  const rejectRef = useRef<((err: Error) => void) | null>(null);

  const [state, setState] = useState<WorkerState>({
    ready: false,
    initError: null,
    splitting: false,
    progress: 0,
    progressMessage: "",
  });

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/pdf.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      switch (msg.type) {
        case "init-done":
          setState((s) => ({ ...s, ready: true }));
          break;
        case "init-error":
          setState((s) => ({ ...s, initError: msg.error }));
          break;
        case "split-progress":
          setState((s) => ({
            ...s,
            progress: msg.progress,
            progressMessage: msg.message,
          }));
          break;
        case "split-done":
          setState((s) => ({ ...s, splitting: false }));
          resolveRef.current?.(msg.parts);
          resolveRef.current = null;
          rejectRef.current = null;
          break;
        case "split-error":
          setState((s) => ({ ...s, splitting: false }));
          rejectRef.current?.(new Error(msg.error));
          resolveRef.current = null;
          rejectRef.current = null;
          break;
      }
    };

    const initMsg: ToWorker = { type: "init" };
    worker.postMessage(initMsg);

    return () => worker.terminate();
  }, []);

  const splitPdf = useCallback(
    (pdfBytes: Uint8Array, splitAfterPages: number[]): Promise<PdfPart[]> => {
      return new Promise((resolve, reject) => {
        if (!workerRef.current) {
          reject(new Error("Worker not initialized"));
          return;
        }
        resolveRef.current = resolve;
        rejectRef.current = reject;
        setState((s) => ({
          ...s,
          splitting: true,
          progress: 0,
          progressMessage: "Starting…",
        }));
        const msg: ToWorker = { type: "split", pdfBytes, splitAfterPages };
        workerRef.current.postMessage(msg);
      });
    },
    [],
  );

  return { ...state, splitPdf };
}
