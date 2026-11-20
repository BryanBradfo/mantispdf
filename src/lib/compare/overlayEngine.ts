import type { PageResult } from "./overlay";

/** The stage computes the page on show; the scan checks every page for the filter. Each has its own worker. */
export type Lane = "stage" | "scan";

export interface PairOutput<O> {
  ratio: number;
  overlay: O;
}

export interface EngineDeps<O> {
  /** Render and diff page pair `page` on the fixed grid; rejects when `signal` aborts. */
  compute(page: number, lane: Lane, signal: AbortSignal): Promise<PairOutput<O>>;
  /** Drop the lane's stale diff (terminate its worker) so the next one does not wait behind it. */
  resetLane(lane: Lane): void;
  /** Free an overlay the engine no longer keeps. */
  release(overlay: O): void;
  /** Give the main thread back between two scanned pages. */
  idle(): Promise<void>;
  /** How many overlays to keep (the stage page is always kept). */
  keep?: number;
}

export type ScanState = { status: "idle" } | { status: "running" | "done"; done: number; total: number };

function abortError(): Error {
  const e = new Error("Overlay cancelled");
  e.name = "AbortError";
  return e;
}

/** `p`, or an AbortError as soon as `signal` aborts (a superseded caller never waits for stale work). */
function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(abortError());
    signal.addEventListener("abort", stop, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", stop);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(e);
      },
    );
  });
}

/**
 * The overlay's computations for one pair of documents: a per-page cache shared by the stage and
 * the scan (ratios for every page, masks only for the last few pages shown), deduplicated work in flight, and the scan
 * that pauses while the stage is loading and reads the known pages live. Framework-free; the view
 * subscribes to it.
 */
export class OverlayEngine<O> {
  private results = new Map<number, PageResult>();
  private readonly overlays = new Map<number, O>();
  private readonly inflight = new Map<number, Promise<PairOutput<O>>>();
  private pinned: number | null = null;
  private stageCtrl: AbortController | null = null;
  /** The stage request in flight (page and its promise), reused when the same page is asked again. */
  private staging: { page: number; promise: Promise<PairOutput<O>> } | null = null;
  private scanCtrl: AbortController | null = null;
  private scan: ScanState = { status: "idle" };
  private pauses = 0;
  private waiters: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private readonly keep: number;

  constructor(private readonly deps: EngineDeps<O>) {
    this.keep = deps.keep ?? 4;
  }

  getResults(): ReadonlyMap<number, PageResult> {
    return this.results;
  }

  getScan(): ScanState {
    return this.scan;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** The pair on show: from the cache, from the scan's work on it, or computed now. Supersedes the previous stage. */
  stage(page: number): Promise<PairOutput<O>> {
    if (this.disposed) return Promise.reject(abortError());
    // The same page asked again while it loads (a resize): the grid does not depend on the screen, reuse the run.
    if (this.staging && this.staging.page === page) return this.staging.promise;
    this.pinned = page;
    if (this.stageCtrl) {
      this.stageCtrl.abort();
      this.deps.resetLane("stage");
    }
    const ctrl = new AbortController();
    this.stageCtrl = ctrl;
    const promise = this.pauseWhile(async () => {
      for (;;) {
        if (ctrl.signal.aborted) throw abortError();
        const r = this.results.get(page);
        const hit = this.overlays.get(page);
        if (r?.status === "done" && hit !== undefined) {
          this.touch(page, hit);
          return { ratio: r.ratio, overlay: hit };
        }
        const pending = this.inflight.get(page);
        if (!pending) break;
        try {
          await untilAbort(pending, ctrl.signal);
        } catch (e) {
          if (ctrl.signal.aborted) throw abortError();
          if (this.results.get(page)?.status === "error") throw e;
          // The scan's run was cancelled: compute it here.
        }
      }
      const out = await untilAbort(this.run(page, "stage", ctrl.signal), ctrl.signal);
      if (ctrl.signal.aborted) throw abortError();
      return out;
    });
    const staging = { page, promise };
    this.staging = staging;
    const done = () => {
      if (this.staging === staging) this.staging = null;
    };
    promise.then(done, done);
    return promise;
  }

  /** Hold the scan while `fn` runs (the stage's own renders). */
  async pauseWhile<T>(fn: () => Promise<T>): Promise<T> {
    this.pauses++;
    try {
      return await fn();
    } finally {
      this.pauses--;
      if (this.pauses === 0) this.wake();
    }
  }

  /** Check `pages` one at a time (the filter), skipping the known ones. */
  startScan(pages: readonly number[]): void {
    this.stopScan();
    if (this.disposed) return;
    const ctrl = new AbortController();
    this.scanCtrl = ctrl;
    const total = pages.length;
    const progress = (status: "running" | "done") => {
      if (ctrl.signal.aborted) return;
      this.scan = { status, done: pages.filter((p) => this.results.has(p)).length, total };
      this.emit();
    };
    progress("running");
    void (async () => {
      for (const page of pages) {
        await this.deps.idle();
        await this.unpaused();
        if (ctrl.signal.aborted) return;
        // Wait for any run of this page in flight (the stage's), again after each one ends: an aborted
        // run may already have been replaced by a new one. Compute it here only when none is left.
        for (;;) {
          if (ctrl.signal.aborted) return;
          if (this.results.has(page)) break;
          const pending = this.inflight.get(page);
          if (pending) {
            try {
              await untilAbort(pending, ctrl.signal);
            } catch {
              // Aborted or failed: look again.
            }
            continue;
          }
          try {
            await untilAbort(this.run(page, "scan", ctrl.signal), ctrl.signal);
          } catch {
            if (ctrl.signal.aborted) return;
          }
          break;
        }
        progress("running");
      }
      progress("done");
    })();
  }

  stopScan(): void {
    if (!this.scanCtrl) return;
    this.scanCtrl.abort();
    this.scanCtrl = null;
    this.deps.resetLane("scan");
    this.scan = { status: "idle" };
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stageCtrl?.abort();
    this.scanCtrl?.abort();
    for (const o of this.overlays.values()) this.deps.release(o);
    this.overlays.clear();
    this.wake();
    this.listeners.clear();
  }

  private run(page: number, lane: Lane, signal: AbortSignal): Promise<PairOutput<O>> {
    const p = this.deps.compute(page, lane, signal).then(
      (out) => {
        if (this.disposed) {
          this.deps.release(out.overlay);
          throw abortError();
        }
        this.setResult(page, { status: "done", ratio: out.ratio });
        // Masks are kept for the page on show (and the last few shown); a scanned page keeps its ratio only.
        if (lane !== "stage" && page !== this.pinned) {
          this.deps.release(out.overlay);
          return out;
        }
        return { ratio: out.ratio, overlay: this.store(page, out.overlay) };
      },
      (e: unknown) => {
        if (!signal.aborted && !this.disposed) this.setResult(page, { status: "error" });
        throw signal.aborted || this.disposed ? abortError() : e;
      },
    );
    this.inflight.set(page, p);
    const clear = () => {
      if (this.inflight.get(page) === p) this.inflight.delete(page);
    };
    p.then(clear, clear);
    return p;
  }

  private setResult(page: number, r: PageResult) {
    this.results = new Map(this.results).set(page, r);
    this.emit();
  }

  /**
   * Keep `overlay` as the page's mask and return the mask to use. Idempotent: a mask already kept
   * for the page (maybe on screen) stays, and the new one is freed instead.
   */
  private store(page: number, overlay: O): O {
    const old = this.overlays.get(page);
    if (old !== undefined) {
      if (old !== overlay) this.deps.release(overlay);
      this.touch(page, old);
      return old;
    }
    this.touch(page, overlay);
    for (const key of this.overlays.keys()) {
      if (this.overlays.size <= this.keep) break;
      if (key === this.pinned) continue;
      this.deps.release(this.overlays.get(key) as O);
      this.overlays.delete(key);
    }
    return overlay;
  }

  /** Most recently used last. */
  private touch(page: number, overlay: O) {
    this.overlays.delete(page);
    this.overlays.set(page, overlay);
  }

  private unpaused(): Promise<void> {
    if (this.pauses === 0 || this.disposed) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
