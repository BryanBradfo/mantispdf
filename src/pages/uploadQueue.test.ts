import { describe, expect, it } from "vitest";
import { createUploadQueue } from "./uploadQueue";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const landed: string[] = [];
  const errors: unknown[] = [];
  const pending: number[] = [];
  const queue = createUploadQueue<string>({
    onResult: (r) => landed.push(r),
    onError: (e) => errors.push(e),
    onPending: (n) => pending.push(n),
  });
  return { queue, landed, errors, pending };
}

describe("createUploadQueue", () => {
  it("lands both batches in drop order even if the second finishes first", async () => {
    const { queue, landed, pending } = setup();
    const a = deferred<string>();
    const b = deferred<string>();
    queue.enqueue(() => a.promise);
    queue.enqueue(() => b.promise);
    b.resolve("B");
    await tick();
    expect(landed).toEqual([]);
    a.resolve("A");
    await tick();
    expect(landed).toEqual(["A", "B"]);
    expect(pending[pending.length - 1]).toBe(0);
  });

  it("lands nothing when cancelled during a batch, and skips queued batches", async () => {
    const { queue, landed, pending } = setup();
    const a = deferred<string>();
    let secondRan = false;
    queue.enqueue(() => a.promise);
    queue.enqueue(async () => {
      secondRan = true;
      return "B";
    });
    queue.cancel();
    a.resolve("A");
    await tick();
    expect(landed).toEqual([]);
    expect(secondRan).toBe(false);
    expect(pending[pending.length - 1]).toBe(0);
  });

  it("accepts new batches after a cancel", async () => {
    const { queue, landed } = setup();
    const a = deferred<string>();
    queue.enqueue(() => a.promise);
    queue.cancel();
    queue.enqueue(async () => "C");
    a.resolve("A");
    await tick();
    expect(landed).toEqual(["C"]);
  });

  it("reports a failed batch and keeps processing the next", async () => {
    const { queue, landed, errors } = setup();
    queue.enqueue(async () => {
      throw new Error("bad");
    });
    queue.enqueue(async () => "B");
    await tick();
    expect(errors).toHaveLength(1);
    expect(landed).toEqual(["B"]);
  });
});
