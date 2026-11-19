import { describe, expect, it } from "vitest";
import { createFontStoreCache, type FontStoreLike } from "./fontStore";

/** A store holding at most `limit` files; any use after free throws. */
function fakeStores(limit: number) {
  const made: { files: Set<string>; freed: boolean }[] = [];
  const make = (): FontStoreLike => {
    const state = { files: new Set<string>(), freed: false };
    made.push(state);
    const live = () => {
      if (state.freed) throw new Error("used after free");
    };
    return {
      has: (id) => (live(), state.files.has(id)),
      add: (id) => {
        live();
        if (state.files.size >= limit) throw new Error("Invalid edit settings: font");
        state.files.add(id);
      },
      free: () => {
        live();
        state.freed = true;
      },
    };
  };
  return { make, made };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("font store cache", () => {
  it("never hands out a freed store when layouts overlap, and a failed fetch frees nothing", async () => {
    const { make, made } = fakeStores(2);
    const fetchFont = async (f: string) => {
      await tick();
      if (f === "broken") throw new Error("Could not load broken (404)");
      return new Uint8Array([1]);
    };
    const cache = createFontStoreCache(make, fetchFont);
    const use = (files: string[]) => cache.withStore(files, (s) => files.map((f) => s.has(f)));
    // Three at once: two fill the store past its limit, one fetch fails.
    const results = await Promise.allSettled([use(["a", "b"]), use(["c", "d"]), use(["a", "broken"])]);
    expect(results[0]).toEqual({ status: "fulfilled", value: [true, true] });
    expect(results[1]).toEqual({ status: "fulfilled", value: [true, true] });
    expect(results[2]).toMatchObject({ status: "rejected", reason: new Error("Could not load broken (404)") });
    // One store was freed for being full; the failed fetch freed none.
    expect(made.filter((m) => m.freed)).toHaveLength(1);
    expect(made[made.length - 1].freed).toBe(false);
  });

  it("frees the store on reset, and a set that cannot fit at all fails", async () => {
    const { make, made } = fakeStores(1);
    const cache = createFontStoreCache(make, async () => new Uint8Array([1]));
    await cache.withStore(["a"], () => null);
    cache.reset();
    expect(made[0].freed).toBe(true);
    await expect(cache.withStore(["a", "b"], () => null)).rejects.toThrow("Invalid edit settings: font");
  });
});
