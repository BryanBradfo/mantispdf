import { describe, expect, it } from "vitest";
import { handlePixelMessage } from "../../workers/pixelDiff.worker";
import { createPixelDiffer, type PixelWorkerLike } from "./pixelClient";
import type { PixelRequest, PixelResponse } from "./pixelClient";

const RED = [198, 40, 40, 140] as const;

function pixels(w: number, h: number, dark: number[] = []) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const p of dark) data.set([0, 0, 0, 255], p * 4);
  return data;
}

/** A worker double that answers through the real handler, asynchronously, and can hold messages. */
function fakeWorker() {
  const sent: PixelRequest[] = [];
  let terminated = false;
  const w: PixelWorkerLike & { flush: () => void; sent: PixelRequest[]; terminated: () => boolean } = {
    onmessage: null,
    onerror: null,
    postMessage(msg: PixelRequest) {
      sent.push(msg);
    },
    terminate() {
      terminated = true;
    },
    flush() {
      for (const m of sent.splice(0)) w.onmessage?.({ data: handlePixelMessage(m) } as MessageEvent<PixelResponse>);
    },
    sent,
    terminated: () => terminated,
  };
  return w;
}

describe("handlePixelMessage", () => {
  it("returns the ratio and the painted overlay", () => {
    const res = handlePixelMessage({ type: "diff", id: 7, width: 5, height: 5, a: pixels(5, 5).buffer, b: pixels(5, 5, [12]).buffer, rgba: RED });
    expect(res.type).toBe("success");
    if (res.type !== "success") return;
    expect(res.id).toBe(7);
    expect(res.changed).toBe(1);
    expect(res.ratio).toBeCloseTo(1 / 25);
    const overlay = new Uint8ClampedArray(res.overlay);
    expect(overlay.length).toBe(100);
    // The whole 5 x 5 image is within 2 px of the centre pixel.
    expect(overlay[3]).toBe(140);
  });

  it("answers a failure for different sizes instead of throwing", () => {
    const res = handlePixelMessage({ type: "diff", id: 3, width: 5, height: 5, a: pixels(5, 5).buffer, b: pixels(5, 4).buffer, rgba: RED });
    expect(res).toMatchObject({ type: "failure", id: 3 });
  });
});

describe("createPixelDiffer", () => {
  it("correlates answers by id", async () => {
    const w = fakeWorker();
    const differ = createPixelDiffer(() => w);
    const one = differ.diff({ width: 2, height: 1, data: pixels(2, 1) }, { width: 2, height: 1, data: pixels(2, 1, [1]) }, RED);
    const two = differ.diff({ width: 2, height: 1, data: pixels(2, 1) }, { width: 2, height: 1, data: pixels(2, 1) }, RED);
    w.flush();
    expect((await one).changed).toBe(1);
    expect((await two).changed).toBe(0);
  });

  it("rejects pending work and stops the worker on dispose", async () => {
    const w = fakeWorker();
    const differ = createPixelDiffer(() => w);
    const p = differ.diff({ width: 1, height: 1, data: pixels(1, 1) }, { width: 1, height: 1, data: pixels(1, 1) }, RED);
    differ.dispose();
    await expect(p).rejects.toThrow();
    expect(w.terminated()).toBe(true);
    await expect(differ.diff({ width: 1, height: 1, data: pixels(1, 1) }, { width: 1, height: 1, data: pixels(1, 1) }, RED)).rejects.toThrow();
  });

  it("rejects pending work when the worker crashes", async () => {
    const w = fakeWorker();
    const differ = createPixelDiffer(() => w);
    const p = differ.diff({ width: 1, height: 1, data: pixels(1, 1) }, { width: 1, height: 1, data: pixels(1, 1) }, RED);
    w.onerror?.(new Event("error"));
    await expect(p).rejects.toThrow(/crashed/);
  });

  it("reset drops a stale diff: it rejects, the worker stops, the next diff gets a fresh worker", async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const differ = createPixelDiffer(() => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    });
    const img = () => ({ width: 1, height: 1, data: pixels(1, 1) });
    const stale = differ.diff(img(), img(), RED);
    differ.reset();
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].terminated()).toBe(true);
    const next = differ.diff(img(), img(), RED);
    expect(workers).toHaveLength(2);
    workers[1].flush();
    expect((await next).changed).toBe(0);
    // Nothing pending: reset keeps the worker.
    differ.reset();
    expect(workers[1].terminated()).toBe(false);
  });
});
