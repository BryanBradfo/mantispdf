import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { ToWorker, FromWorker } from "../lib/workerProtocol";
import type { PdfPart } from "../types/pdf";

interface WorkerState {
  ready: boolean;
  initError: string | null;
  splitting: boolean;
  merging: boolean;
  compressing: boolean;
  rotating: boolean;
  editing: boolean;
  progress: number;
  progressMessage: string;
}

export function usePdfWorker() {
  const workerRef = useRef<Worker | null>(null);
  const splitResolveRef = useRef<((parts: PdfPart[]) => void) | null>(null);
  const splitRejectRef = useRef<((err: Error) => void) | null>(null);
  const mergeResolveRef = useRef<((bytes: Uint8Array) => void) | null>(null);
  const mergeRejectRef = useRef<((err: Error) => void) | null>(null);
  const countResolveRef = useRef<((count: number) => void) | null>(null);
  const countRejectRef = useRef<((err: Error) => void) | null>(null);
  const compressResolveRef = useRef<((buf: ArrayBuffer) => void) | null>(null);
  const compressRejectRef = useRef<((err: Error) => void) | null>(null);
  const rotateResolveRef = useRef<((buf: ArrayBuffer) => void) | null>(null);
  const rotateRejectRef = useRef<((err: Error) => void) | null>(null);
  const editResolveRef = useRef<((buf: ArrayBuffer) => void) | null>(null);
  const editRejectRef = useRef<((err: Error) => void) | null>(null);

  const [state, setState] = useState<WorkerState>({
    ready: false,
    initError: null,
    splitting: false,
    merging: false,
    compressing: false,
    rotating: false,
    editing: false,
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
          splitResolveRef.current?.(msg.parts);
          splitResolveRef.current = null;
          splitRejectRef.current = null;
          break;
        case "split-error":
          setState((s) => ({ ...s, splitting: false }));
          splitRejectRef.current?.(new Error(msg.error));
          splitResolveRef.current = null;
          splitRejectRef.current = null;
          break;
        case "merge-progress":
          setState((s) => ({
            ...s,
            progress: msg.progress,
            progressMessage: msg.message,
          }));
          break;
        case "merge-done":
          setState((s) => ({ ...s, merging: false }));
          mergeResolveRef.current?.(msg.bytes);
          mergeResolveRef.current = null;
          mergeRejectRef.current = null;
          break;
        case "merge-error":
          setState((s) => ({ ...s, merging: false }));
          mergeRejectRef.current?.(new Error(msg.error));
          mergeResolveRef.current = null;
          mergeRejectRef.current = null;
          break;
        case "count-done":
          countResolveRef.current?.(msg.count);
          countResolveRef.current = null;
          countRejectRef.current = null;
          break;
        case "count-error":
          countRejectRef.current?.(new Error(msg.error));
          countResolveRef.current = null;
          countRejectRef.current = null;
          break;
        case "compress-done":
          setState((s) => ({ ...s, compressing: false }));
          compressResolveRef.current?.(msg.result);
          compressResolveRef.current = null;
          compressRejectRef.current = null;
          break;
        case "compress-error":
          setState((s) => ({ ...s, compressing: false }));
          compressRejectRef.current?.(new Error(msg.error));
          compressResolveRef.current = null;
          compressRejectRef.current = null;
          break;
        case "rotate-done":
          setState((s) => ({ ...s, rotating: false }));
          rotateResolveRef.current?.(msg.result);
          rotateResolveRef.current = null;
          rotateRejectRef.current = null;
          break;
        case "rotate-error":
          setState((s) => ({ ...s, rotating: false }));
          rotateRejectRef.current?.(new Error(msg.error));
          rotateResolveRef.current = null;
          rotateRejectRef.current = null;
          break;
        case "edit-done":
          setState((s) => ({ ...s, editing: false }));
          editResolveRef.current?.(msg.result);
          editResolveRef.current = null;
          editRejectRef.current = null;
          break;
        case "edit-error":
          setState((s) => ({ ...s, editing: false }));
          editRejectRef.current?.(new Error(msg.message));
          editResolveRef.current = null;
          editRejectRef.current = null;
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
        splitResolveRef.current = resolve;
        splitRejectRef.current = reject;
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

  const mergePdfs = useCallback(
    (pdfBuffers: Uint8Array[]): Promise<Uint8Array> => {
      return new Promise((resolve, reject) => {
        if (!workerRef.current) {
          reject(new Error("Worker not initialized"));
          return;
        }
        mergeResolveRef.current = resolve;
        mergeRejectRef.current = reject;
        setState((s) => ({
          ...s,
          merging: true,
          progress: 0,
          progressMessage: "Starting merge…",
        }));
        const msg: ToWorker = { type: "merge", pdfBuffers };
        workerRef.current.postMessage(msg);
      });
    },
    [],
  );

  const countPages = useCallback(
    (pdfBytes: Uint8Array): Promise<number> => {
      return new Promise((resolve, reject) => {
        if (!workerRef.current) {
          reject(new Error("Worker not initialized"));
          return;
        }
        countResolveRef.current = resolve;
        countRejectRef.current = reject;
        const msg: ToWorker = { type: "count-pages", pdfBytes };
        workerRef.current.postMessage(msg);
      });
    },
    [],
  );

  const compressPdf = useCallback(
    (file: File): Promise<ArrayBuffer> => {
      return new Promise((resolve, reject) => {
        if (!workerRef.current) {
          reject(new Error("Worker not initialized"));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const pdfBytes = reader.result as ArrayBuffer;
          compressResolveRef.current = resolve;
          compressRejectRef.current = reject;
          setState((s) => ({ ...s, compressing: true }));
          const msg: ToWorker = { type: "compress", pdfBytes };
          workerRef.current!.postMessage(msg, [pdfBytes]);
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsArrayBuffer(file);
      });
    },
    [],
  );

  const rotatePdf = useCallback(
    (file: File, rotations: number[]): Promise<ArrayBuffer> => {
      return new Promise((resolve, reject) => {
        if (!workerRef.current) {
          reject(new Error("Worker not initialized"));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const pdfBytes = reader.result as ArrayBuffer;
          rotateResolveRef.current = resolve;
          rotateRejectRef.current = reject;
          setState((s) => ({ ...s, rotating: true }));
          const msg: ToWorker = { type: "rotate", pdfBytes, rotations };
          workerRef.current!.postMessage(msg, [pdfBytes]);
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsArrayBuffer(file);
      });
    },
    [],
  );

  const editPages = useCallback(
    (pdfBytes: Uint8Array, newOrder: number[]): Promise<ArrayBuffer> => {
      return new Promise((resolve, reject) => {
        if (!workerRef.current) {
          reject(new Error("Worker not initialized"));
          return;
        }
        editResolveRef.current = resolve;
        editRejectRef.current = reject;
        setState((s) => ({ ...s, editing: true }));
        const msg: ToWorker = { type: "edit-pages", pdfBytes, newOrder };
        workerRef.current.postMessage(msg);
      });
    },
    [],
  );

  return useMemo(
    () => ({ ...state, splitPdf, mergePdfs, countPages, compressPdf, rotatePdf, editPages }),
    [state, splitPdf, mergePdfs, countPages, compressPdf, rotatePdf, editPages],
  );
}
