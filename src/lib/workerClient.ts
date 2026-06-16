import type { FromWorker, ReqId, SuccessPayload, ToWorker } from "./workerProtocol";

type Pending = {
  resolve: (payload: SuccessPayload) => void;
  reject: (err: Error) => void;
};

export interface RequestOptions {
  transfer?: Transferable[];
  onProgress?: (progress: number, message: string) => void;
}

/**
 * Correlates request/response messages by id over a postMessage transport.
 *
 * Deliberately independent of React and the real `Worker` so it can be unit
 * tested with a fake transport. Fixes two worker-layer bugs:
 *  - **J1**: each request gets a unique id and its own pending entry, so two
 *    in-flight operations of the same kind can never overwrite each other's
 *    resolver (the previous single-slot refs caused the first promise to hang
 *    and could resolve the wrong one).
 *  - **J2**: `handleError` rejects every pending request — wire it to the
 *    worker's `onerror`/`onmessageerror` so a worker crash surfaces as a
 *    rejection instead of a promise that never settles.
 */
export class PdfWorkerClient {
  private readonly pending = new Map<ReqId, Pending>();
  private readonly progressHandlers = new Map<ReqId, (progress: number, message: string) => void>();
  private nextId = 1;

  constructor(private readonly post: (msg: ToWorker, transfer?: Transferable[]) => void) {}

  /**
   * Send a request and resolve when its matching `success` arrives.
   * `build` receives the freshly-allocated id; `extract` turns the tagged
   * payload into the operation's concrete return type.
   */
  request<T>(
    build: (id: ReqId) => ToWorker,
    extract: (payload: SuccessPayload) => T,
    options: RequestOptions = {},
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (payload) => {
          try {
            resolve(extract(payload));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
        reject,
      });
      if (options.onProgress) this.progressHandlers.set(id, options.onProgress);

      try {
        this.post(build(id), options.transfer);
      } catch (e) {
        this.pending.delete(id);
        this.progressHandlers.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Feed a message received from the worker. Ignores the init handshake. */
  handleMessage(msg: FromWorker): void {
    switch (msg.type) {
      case "progress":
        this.progressHandlers.get(msg.id)?.(msg.progress, msg.message);
        break;
      case "success": {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          this.progressHandlers.delete(msg.id);
          entry.resolve(msg.payload);
        }
        break;
      }
      case "failure": {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          this.progressHandlers.delete(msg.id);
          entry.reject(new Error(msg.error));
        }
        break;
      }
      // init-done / init-error are handled by the hook (they set ready state).
    }
  }

  /** Reject every in-flight request. Call from worker.onerror / onmessageerror. */
  handleError(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
    this.progressHandlers.clear();
  }

  /** Number of in-flight requests (for tests/diagnostics). */
  get pendingCount(): number {
    return this.pending.size;
  }
}
