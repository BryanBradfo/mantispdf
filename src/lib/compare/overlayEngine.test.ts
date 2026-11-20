import { describe, expect, it, vi } from "vitest";
import { OverlayEngine, type EngineDeps, type Lane } from "./overlayEngine";

type Call = { page: number; lane: Lane; signal: AbortSignal; resolve: (ratio: number) => void; reject: (e: Error) => void };

/** Deps whose computations stay pending until the test settles them. */
function deps(keep = 4) {
  const calls: Call[] = [];
  const released: string[] = [];
  const resets: Lane[] = [];
  const d: EngineDeps<string> = {
    compute: (page, lane, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ page, lane, signal, resolve: (ratio) => resolve({ ratio, overlay: `o${page}` }), reject });
      }),
    resetLane: (lane) => resets.push(lane),
    release: (o) => released.push(o),
    idle: () => Promise.resolve(),
    keep,
  };
  return { d, calls, released, resets };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("OverlayEngine", () => {
  it("computes the stage page once and serves it from the cache", async () => {
    const { d, calls } = deps();
    const e = new OverlayEngine(d);
    const first = e.stage(1);
    await flush();
    calls[0].resolve(0.02);
    expect(await first).toEqual({ ratio: 0.02, overlay: "o1" });
    expect(await e.stage(1)).toEqual({ ratio: 0.02, overlay: "o1" });
    expect(calls).toHaveLength(1);
    expect(e.getResults().get(1)).toEqual({ status: "done", ratio: 0.02 });
  });

  it("a new stage page aborts the old one and drops its stale diff", async () => {
    const { d, calls, resets } = deps();
    const e = new OverlayEngine(d);
    const one = e.stage(1);
    await flush();
    const two = e.stage(2);
    await expect(one).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0].signal.aborted).toBe(true);
    expect(resets).toEqual(["stage"]);
    await flush();
    calls[1].resolve(0);
    expect((await two).ratio).toBe(0);
    // The aborted page left no result behind.
    expect(e.getResults().has(1)).toBe(false);
  });

  it("the scan skips pages already known and counts its progress", async () => {
    const { d, calls } = deps();
    const e = new OverlayEngine(d);
    const s = e.stage(1);
    await flush();
    calls[0].resolve(0.1);
    await s;
    e.startScan([1, 2, 3]);
    await flush();
    expect(calls.map((c) => [c.page, c.lane])).toEqual([[1, "stage"], [2, "scan"]]);
    expect(e.getScan()).toEqual({ status: "running", done: 1, total: 3 });
    calls[1].resolve(0);
    await flush();
    expect(e.getScan()).toEqual({ status: "running", done: 2, total: 3 });
    calls[2].resolve(0.5);
    await flush();
    expect(e.getScan()).toEqual({ status: "done", done: 3, total: 3 });
    expect([...e.getResults().keys()].sort()).toEqual([1, 2, 3]);
  });

  it("reads the known pages live: a page the stage computes meanwhile is not recomputed", async () => {
    const { d, calls } = deps();
    const e = new OverlayEngine(d);
    e.startScan([1, 2, 3]);
    await flush();
    expect(calls.map((c) => c.page)).toEqual([1]);
    // The person looks at page 3 while page 1 is scanned.
    const s = e.stage(3);
    await flush();
    calls[0].resolve(0);
    await flush();
    // Paused while the stage loads.
    expect(calls.map((c) => c.page)).toEqual([1, 3]);
    calls[1].resolve(0.3);
    await s;
    await flush();
    expect(calls.map((c) => c.page)).toEqual([1, 3, 2]);
    calls[2].resolve(0);
    await flush();
    expect(calls).toHaveLength(3);
    expect(e.getScan()).toMatchObject({ status: "done" });
  });

  it("the stage waits for the scan's computation of the same page", async () => {
    const { d, calls } = deps();
    const e = new OverlayEngine(d);
    e.startScan([1, 2]);
    await flush();
    const s = e.stage(1);
    await flush();
    calls[0].resolve(0.2);
    expect(await s).toEqual({ ratio: 0.2, overlay: "o1" });
    expect(calls.filter((c) => c.page === 1)).toHaveLength(1);
  });

  it("pauses the scan while something else holds the stage", async () => {
    const { d, calls } = deps();
    const e = new OverlayEngine(d);
    let done!: () => void;
    const held = e.pauseWhile(() => new Promise<void>((r) => (done = r)));
    e.startScan([1]);
    await flush();
    expect(calls).toHaveLength(0);
    done();
    await held;
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("dispose cancels the scan, its work in flight and frees the overlays", async () => {
    const { d, calls, released } = deps();
    const e = new OverlayEngine(d);
    const s = e.stage(1);
    await flush();
    calls[0].resolve(0);
    await s;
    e.startScan([1, 2, 3]);
    await flush();
    e.dispose();
    expect(calls[1].signal.aborted).toBe(true);
    calls[1].resolve(0);
    await flush();
    expect(calls).toHaveLength(2);
    // The cached overlay and the one finished after dispose are both freed.
    expect(released.sort()).toEqual(["o1", "o2"]);
    expect(e.getResults().has(2)).toBe(false);
  });

  it("stopping the scan drops its diff in the worker", async () => {
    const { d, calls, resets } = deps();
    const e = new OverlayEngine(d);
    e.startScan([1, 2]);
    await flush();
    e.stopScan();
    expect(calls[0].signal.aborted).toBe(true);
    expect(resets).toEqual(["scan"]);
    expect(e.getScan()).toEqual({ status: "idle" });
  });

  it("keeps a few overlays, never evicting the stage page", async () => {
    const { d, calls, released } = deps(2);
    const e = new OverlayEngine(d);
    const s = e.stage(1);
    await flush();
    calls[0].resolve(0);
    await s;
    e.startScan([2, 3, 4]);
    for (let i = 1; i <= 3; i++) {
      await flush();
      calls[i].resolve(0);
    }
    await flush();
    expect(released).toEqual(["o2", "o3"]);
    expect(await e.stage(1)).toEqual({ ratio: 0, overlay: "o1" });
  });

  it("records a failed page as an error (not when cancelled)", async () => {
    const { d, calls } = deps();
    const e = new OverlayEngine(d);
    const s = e.stage(1);
    await flush();
    calls[0].reject(new Error("boom"));
    await expect(s).rejects.toThrow("boom");
    expect(e.getResults().get(1)).toEqual({ status: "error" });
  });

  it("notifies subscribers", async () => {
    const { d, calls } = deps();
    const e = new OverlayEngine(d);
    const fn = vi.fn();
    e.subscribe(fn);
    const s = e.stage(1);
    await flush();
    calls[0].resolve(0);
    await s;
    expect(fn).toHaveBeenCalled();
  });
});
