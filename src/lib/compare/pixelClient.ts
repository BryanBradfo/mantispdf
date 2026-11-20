import type { Pixels } from "./pixelDiff";

export type Rgba = readonly [number, number, number, number];

export type PixelRequest = { type: "diff"; id: number; width: number; height: number; a: ArrayBuffer; b: ArrayBuffer; rgba: Rgba };
export type PixelResponse =
  | { type: "success"; id: number; changed: number; ratio: number; overlay: ArrayBuffer }
  | { type: "failure"; id: number; error: string };

export interface PixelResult {
  changed: number;
  ratio: number;
  /** RGBA pixels of the overlay (the colour where pixels differ, transparent elsewhere). */
  overlay: Uint8ClampedArray<ArrayBuffer>;
}

/** The parts of a Worker used here (lets tests inject a fake). */
export interface PixelWorkerLike {
  postMessage(msg: PixelRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<PixelResponse>) => void) | null;
  onerror: ((e: Event) => void) | null;
}

const defaultSpawn = (): PixelWorkerLike =>
  new Worker(new URL("../../workers/pixelDiff.worker.ts", import.meta.url), { type: "module" }) as unknown as PixelWorkerLike;

type Pending = { resolve: (r: PixelResult) => void; reject: (e: Error) => void };

/**
 * The pixel diff off the main thread: about 0.4 s for a pair of 2000 px renders, far over a frame.
 * Request-ID correlated; `dispose` terminates the worker (the running diff stops) and rejects what
 * is pending. The pixel buffers are transferred, so callers must not reuse them.
 */
export function createPixelDiffer(spawn: () => PixelWorkerLike = defaultSpawn) {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let worker: PixelWorkerLike | null = null;
  let disposed = false;

  const failAll = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  const ensure = (): PixelWorkerLike => {
    if (worker) return worker;
    const w = spawn();
    w.onmessage = (e) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === "success") p.resolve({ changed: msg.changed, ratio: msg.ratio, overlay: new Uint8ClampedArray(msg.overlay) });
      else p.reject(new Error(msg.error));
    };
    w.onerror = () => {
      if (worker !== w) return;
      failAll(new Error("Pixel diff worker crashed"));
      w.terminate();
      worker = null; // the next diff spawns a fresh one
    };
    worker = w;
    return w;
  };

  return {
    diff(a: Pixels, b: Pixels, rgba: Rgba): Promise<PixelResult> {
      if (disposed) return Promise.reject(new Error("Pixel diff disposed"));
      const id = nextId++;
      return new Promise<PixelResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const bufA = a.data.buffer as ArrayBuffer;
        const bufB = b.data.buffer as ArrayBuffer;
        try {
          ensure().postMessage({ type: "diff", id, width: a.width, height: a.height, a: bufA, b: bufB, rgba }, bufA === bufB ? [bufA] : [bufA, bufB]);
        } catch (e) {
          pending.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    dispose(): void {
      disposed = true;
      const e = new Error("Pixel diff cancelled");
      e.name = "AbortError";
      failAll(e);
      worker?.terminate();
      worker = null;
    },
  };
}

export type PixelDiffer = ReturnType<typeof createPixelDiffer>;
