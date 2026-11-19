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

  constructor(
    private readonly post: (msg: CompareRequest) => void,
    private readonly onAbort: () => void = () => {},
  ) {}

  compare(a: Word[][], b: Word[][], limits: CompareLimits = DEFAULT_LIMITS): Promise<CompareResult> {
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
    if (this.pending.size === 0) return;
    this.handleError(abortError());
    this.onAbort();
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

/** Spawn the compare worker. Cancelling or superseding terminates and recreates it; `dispose` ends it. */
export function createCompareWorker(): { client: CompareClient; dispose: () => void } {
  let worker: Worker | null = null;
  const spawn = () => {
    const w = new Worker(new URL("../../workers/compare.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<CompareResponse>) => client.handleMessage(e.data);
    w.onerror = () => client.handleError(new Error("Compare worker crashed"));
    w.onmessageerror = () => client.handleError(new Error("Compare worker message error"));
    worker = w;
  };
  const client = new CompareClient(
    (msg) => worker?.postMessage(msg),
    () => {
      worker?.terminate();
      spawn();
    },
  );
  spawn();
  return {
    client,
    dispose: () => {
      worker?.terminate();
      worker = null;
      client.handleError(new Error("Worker terminated"));
    },
  };
}
