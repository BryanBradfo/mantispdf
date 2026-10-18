import { describe, it, expect, vi } from "vitest";
import { ThumbnailStore, docKeyFor } from "./store";
import type { RenderMode, Renderer, RendererDoc } from "./types";

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Fake renderer: every render waits until the test resolves it. */
function setup(opts: { openFails?: boolean } = {}) {
  const renders: { page: number; width: number; mode: RenderMode; d: Deferred<Blob> }[] = [];
  const destroy = vi.fn();
  const opens = vi.fn();
  const renderer: Renderer = {
    async open(bytes) {
      opens(bytes);
      if (opts.openFails) throw new Error("corrupt");
      const doc: RendererDoc = {
        render(page, width, mode) { const d = deferred<Blob>(); renders.push({ page, width, mode, d }); return d.promise; },
        destroy,
      };
      return doc;
    },
  };
  let n = 0;
  const revoked: string[] = [];
  const deferredReleases: (() => void)[] = [];
  const store = new ThumbnailStore(renderer, {
    concurrency: 2,
    createUrl: () => `blob:test/${++n}`,
    revokeUrl: (u) => revoked.push(u),
    defer: (fn) => deferredReleases.push(fn),
  });
  const flushReleases = () => deferredReleases.splice(0).forEach((f) => f());
  return { store, renders, destroy, opens, revoked, flushReleases };
}

const bytes = () => new Uint8Array([1, 2, 3]);

describe("ThumbnailStore", () => {
  it("renders a requested page and caches the URL", async () => {
    const { store, renders } = setup();
    store.register("a", bytes());
    store.request("a", 1, 200);
    expect(store.getThumb("a", 1, 200)).toEqual({ status: "loading" });
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    renders[0].d.resolve(new Blob(["x"]));
    await vi.waitFor(() => expect(store.getThumb("a", 1, 200)).toEqual({ status: "ready", url: "blob:test/1" }));
    store.request("a", 1, 200); // cache hit
    expect(renders).toHaveLength(1);
  });

  it("opens each document once and copies the bytes", async () => {
    const { store, renders, opens } = setup();
    const src = bytes();
    store.register("a", src);
    store.request("a", 1, 200);
    store.request("a", 2, 200);
    await vi.waitFor(() => expect(renders).toHaveLength(2));
    expect(opens).toHaveBeenCalledTimes(1);
    expect(opens.mock.calls[0][0]).not.toBe(src);
  });

  it("never runs more than 2 renders at once", async () => {
    const { store, renders } = setup();
    store.register("a", bytes());
    for (let p = 1; p <= 5; p++) store.request("a", p, 100);
    await vi.waitFor(() => expect(renders).toHaveLength(2));
    expect(store.inFlightCount).toBe(2);
    renders[0].d.resolve(new Blob(["x"]));
    await vi.waitFor(() => expect(renders).toHaveLength(3));
    expect(store.inFlightCount).toBe(2);
  });

  it("release revokes every URL of the doc and destroys it", async () => {
    const { store, renders, destroy, revoked, flushReleases } = setup();
    store.register("a", bytes());
    store.request("a", 1, 100);
    store.request("a", 2, 100);
    await vi.waitFor(() => expect(renders).toHaveLength(2));
    renders.forEach((r) => r.d.resolve(new Blob(["x"])));
    await vi.waitFor(() => expect(store.getThumb("a", 2, 100)?.status).toBe("ready"));
    store.release("a");
    flushReleases();
    expect(revoked.sort()).toEqual(["blob:test/1", "blob:test/2"]);
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(store.getThumb("a", 1, 100)).toBeUndefined();
  });

  it("StrictMode register/release/register keeps URLs valid", async () => {
    const { store, renders, revoked, flushReleases } = setup();
    store.register("a", bytes());
    store.request("a", 1, 100);
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    renders[0].d.resolve(new Blob(["x"]));
    await vi.waitFor(() => expect(store.getThumb("a", 1, 100)?.status).toBe("ready"));
    store.release("a");
    store.register("a", bytes());
    flushReleases();
    expect(revoked).toEqual([]);
    expect(store.getThumb("a", 1, 100)?.status).toBe("ready");
  });

  it("ref-counts multiple consumers", async () => {
    const { store, renders, destroy, revoked, flushReleases } = setup();
    store.register("a", bytes());
    store.register("a", bytes());
    store.request("a", 1, 100);
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    renders[0].d.resolve(new Blob(["x"]));
    await vi.waitFor(() => expect(store.getThumb("a", 1, 100)).toEqual({ status: "ready", url: "blob:test/1" }));
    store.release("a");
    flushReleases();
    expect(store.getThumb("a", 1, 100)).toEqual({ status: "ready", url: "blob:test/1" });
    expect(revoked).toEqual([]);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("dispose during render: no state, no URL, doc destroyed", async () => {
    const { store, renders, revoked, destroy, flushReleases } = setup();
    store.register("a", bytes());
    store.request("a", 1, 100);
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    store.release("a");
    flushReleases();
    renders[0].d.resolve(new Blob(["x"]));
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getThumb("a", 1, 100)).toBeUndefined();
    expect(revoked).toEqual([]);
    expect(store.inFlightCount).toBe(0);
  });

  it("re-register after dispose renders again", async () => {
    const { store, renders, flushReleases } = setup();
    const src = bytes();
    store.register("a", src);
    store.release("a");
    flushReleases();
    store.register("a", src);
    store.request("a", 1, 100);
    await vi.waitFor(() => expect(renders).toHaveLength(1));
  });

  it("render failure -> error state", async () => {
    const { store, renders } = setup();
    store.register("a", bytes());
    store.request("a", 1, 100);
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    renders[0].d.reject(new Error("boom"));
    await vi.waitFor(() => expect(store.getThumb("a", 1, 100)).toEqual({ status: "error" }));
  });

  it("open failure -> every requested page errors", async () => {
    const { store } = setup({ openFails: true });
    store.register("a", bytes());
    store.request("a", 1, 100);
    store.request("a", 2, 100);
    await vi.waitFor(() => {
      expect(store.getThumb("a", 1, 100)).toEqual({ status: "error" });
      expect(store.getThumb("a", 2, 100)).toEqual({ status: "error" });
    });
  });

  it("request on an unregistered doc is ignored", () => {
    const { store } = setup();
    store.request("nope", 1, 100);
    expect(store.getThumb("nope", 1, 100)).toBeUndefined();
  });

  it("notifies subscribers on state changes", async () => {
    const { store, renders } = setup();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.register("a", bytes());
    store.request("a", 1, 100);
    expect(fn).toHaveBeenCalled();
    await vi.waitFor(() => expect(renders).toHaveLength(1));
    fn.mockClear();
    renders[0].d.resolve(new Blob(["x"]));
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    off();
  });

  it("reads Blob sources", async () => {
    const { store, opens } = setup();
    store.register("b", new Blob([new Uint8Array([9, 8])]));
    store.request("b", 1, 100);
    await vi.waitFor(() => expect(opens).toHaveBeenCalledTimes(1));
    expect(Array.from(opens.mock.calls[0][0] as Uint8Array)).toEqual([9, 8]);
  });
});

describe("docKeyFor", () => {
  it("is stable per object and distinct across objects", () => {
    const a = new Uint8Array(1), b = new Uint8Array(1);
    expect(docKeyFor(a)).toBe(docKeyFor(a));
    expect(docKeyFor(a)).not.toBe(docKeyFor(b));
  });

  describe("render modes", () => {
    it("renders the full page by default", async () => {
      const { store, renders } = setup();
      store.register("a", bytes());
      store.request("a", 1, 200);
      await vi.waitFor(() => expect(renders).toHaveLength(1));
      expect(renders[0].mode).toBe("full");
    });

    it("caches a page without form widgets apart from the full page", async () => {
      const { store, renders } = setup();
      store.register("a", bytes());
      store.request("a", 1, 200);
      store.request("a", 1, 200, "no-widgets");
      await vi.waitFor(() => expect(renders).toHaveLength(2));
      expect(renders.map((r) => r.mode)).toEqual(["full", "no-widgets"]);
      renders[1].d.resolve(new Blob(["bare"]));
      await vi.waitFor(() => expect(store.getThumb("a", 1, 200, "no-widgets")).toEqual({ status: "ready", url: "blob:test/1" }));
      // The full page is still its own entry, not the widget-less one.
      expect(store.getThumb("a", 1, 200)).toEqual({ status: "loading" });
      renders[0].d.resolve(new Blob(["full"]));
      await vi.waitFor(() => expect(store.getThumb("a", 1, 200, "full")).toEqual({ status: "ready", url: "blob:test/2" }));
      expect(store.getThumb("a", 1, 200, "no-widgets")).toEqual({ status: "ready", url: "blob:test/1" });
      // Both are cache hits now.
      store.request("a", 1, 200);
      store.request("a", 1, 200, "no-widgets");
      expect(renders).toHaveLength(2);
    });

    it("raises the priority of the matching mode only", async () => {
      const { store, renders } = setup();
      store.register("a", bytes());
      // Fill both render slots, then queue the two modes of page 3.
      store.request("a", 1, 200);
      store.request("a", 2, 200);
      store.request("a", 3, 200);
      store.request("a", 3, 200, "no-widgets");
      store.setVisible("a", 3, 200, true, "no-widgets");
      await vi.waitFor(() => expect(renders).toHaveLength(2));
      renders[0].d.resolve(new Blob(["x"]));
      await vi.waitFor(() => expect(renders).toHaveLength(3));
      expect(renders[2]).toMatchObject({ page: 3, mode: "no-widgets" });
    });
  });
});
