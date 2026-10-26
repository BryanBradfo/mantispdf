/**
 * The worker's preview font store: font files copied into wasm memory once each (a wasm
 * `FontStore`), reused by every layout-text request. Requests overlap (each awaits its font
 * fetches), so a store is only chosen and used after every await, in one synchronous step, and it
 * is freed only when it is full, never because a fetch failed.
 */
export interface FontStoreLike {
  has(id: string): boolean;
  add(id: string, bytes: Uint8Array): void;
  free(): void;
}

/** The store's error when it holds 20 files or 64 MiB. */
const FULL = "Invalid edit settings: font";
const isFull = (e: unknown) => String(e instanceof Error ? e.message : e).includes(FULL);

export function createFontStoreCache<S extends FontStoreLike>(make: () => S, fetchFont: (file: string) => Promise<Uint8Array>) {
  let store: S | null = null;
  return {
    /** Runs `use` with a store holding `files` (fetched first; a failed fetch rejects). */
    async withStore<R>(files: string[], use: (store: S) => R): Promise<R> {
      const bytes = await Promise.all(files.map(async (f) => [f, await fetchFont(f)] as const));
      // No await from here on: the store read now is the one used.
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = (store ??= make());
        try {
          for (const [f, b] of bytes) if (!current.has(f)) current.add(f, b);
          return use(current);
        } catch (e) {
          if (!isFull(e) || attempt === 1) throw e;
          // Full: start a store that holds only what this layout needs.
          current.free();
          store = null;
        }
      }
      throw new Error("unreachable");
    },
    /** Frees the store (a page reset). */
    reset() {
      store?.free();
      store = null;
    },
  };
}
