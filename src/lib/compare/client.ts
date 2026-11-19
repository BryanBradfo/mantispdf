import type { CompareRequest, CompareResponse } from "./protocol";
import { DEFAULT_LIMITS, type CompareLimits, type CompareResult, type Word } from "./types";

type Pending = { resolve: (r: CompareResult) => void; reject: (e: Error) => void };

/** Request-ID correlation over a postMessage transport (mirrors PdfWorkerClient; independent of Worker). */
export class CompareClient {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private readonly post: (msg: CompareRequest) => void) {}

  compare(a: Word[][], b: Word[][], limits: CompareLimits = DEFAULT_LIMITS): Promise<CompareResult> {
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

/** Spawn the compare worker. `dispose` terminates it and rejects in-flight requests. */
export function createCompareWorker(): { client: CompareClient; dispose: () => void } {
  const worker = new Worker(new URL("../../workers/compare.worker.ts", import.meta.url), { type: "module" });
  const client = new CompareClient((msg) => worker.postMessage(msg));
  worker.onmessage = (e: MessageEvent<CompareResponse>) => client.handleMessage(e.data);
  worker.onerror = () => client.handleError(new Error("Compare worker crashed"));
  worker.onmessageerror = () => client.handleError(new Error("Compare worker message error"));
  return {
    client,
    dispose: () => {
      worker.terminate();
      client.handleError(new Error("Worker terminated"));
    },
  };
}
