import type { CompareRequest, CompareResponse } from "./protocol";
import { DEFAULT_LIMITS, type CompareLimits, type CompareResult, type Word } from "./types";

type Pending = { resolve: (r: CompareResult) => void; reject: (e: Error) => void };

export function abortError(): Error {
  const e = new Error("Comparison cancelled");
  e.name = "AbortError";
  return e;
}

/**
 * Request-ID correlation over a postMessage transport (mirrors PdfWorkerClient; independent of Worker).
 * A new `compare()` while one is running supersedes it: the old promise rejects with an AbortError and
 * `onAbort` runs (the worker factory terminates and recreates the worker there, stopping the old diff).
 */
export class CompareClient {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly post: (msg: CompareRequest) => void,
    private readonly onAbort: () => void = () => {},
  ) {}

  compare(a: Word[][], b: Word[][], limits: CompareLimits = DEFAULT_LIMITS): Promise<CompareResult> {
    if (this.closed) return Promise.reject(new Error("Compare client disposed"));
    this.cancel();
    const id = this.nextId++;
    return new Promise<CompareResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.post({ type: "compare", id, a, b, limits });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Reject the running comparison (if any) with an AbortError and stop the worker's work. */
  cancel(): void {
    if (this.closed || this.pending.size === 0) return;
    this.handleError(abortError());
    this.onAbort();
  }

  /** Reject everything in flight and refuse further work (the worker is gone). */
  close(): void {
    this.handleError(new Error("Worker terminated"));
    this.closed = true;
  }

  handleMessage(msg: CompareResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.type === "success") entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
  }

  /** Reject every in-flight request (worker crash). */
  handleError(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

/** The parts of a Worker the factory below uses (lets tests inject a fake). */
export interface WorkerLike {
  postMessage(msg: CompareRequest): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<CompareResponse>) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
}

const defaultSpawn = (): WorkerLike =>
  new Worker(new URL("../../workers/compare.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;

/**
 * Spawn the compare worker. Cancelling or superseding terminates and recreates it, as does a crash
 * (the next `compare()` gets a fresh worker); `dispose` ends it for good (later calls reject).
 */
export function createCompareWorker(spawnWorker: () => WorkerLike = defaultSpawn): { client: CompareClient; dispose: () => void } {
  let worker: WorkerLike | null = null;
  let disposed = false;
  const spawn = () => {
    const w = spawnWorker();
    w.onmessage = (e) => {
      if (w === worker) client.handleMessage(e.data);
    };
    w.onerror = () => {
      if (w !== worker) return;
      client.handleError(new Error("Compare worker crashed"));
      w.terminate();
      if (!disposed) spawn();
    };
    w.onmessageerror = () => {
      if (w === worker) client.handleError(new Error("Compare worker message error"));
    };
    worker = w;
  };
  const client = new CompareClient(
    (msg) => worker?.postMessage(msg),
    () => {
      if (disposed) return;
      worker?.terminate();
      spawn();
    },
  );
  spawn();
  return {
    client,
    dispose: () => {
      disposed = true;
      const w = worker;
      worker = null;
      w?.terminate();
      client.close();
    },
  };
}
