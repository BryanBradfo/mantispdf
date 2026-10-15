import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { pdfjsRenderer } from "./pdfjsRenderer";
import { LOADING, ThumbnailStore, docKeyFor } from "./store";
import type { ThumbState } from "./types";

export const thumbnailStore = new ThumbnailStore(pdfjsRenderer);
export { docKeyFor };
export type { ThumbState };

/**
 * Thumbnail of one page. Registers the source for as long as the caller is
 * mounted (ref-counted, StrictMode-safe) and raises priority while `ref` is near
 * the viewport.
 */
export function useThumbnail(
  source: Blob | Uint8Array,
  page: number,
  width: number,
  ref: RefObject<Element | null>,
): ThumbState {
  const doc = docKeyFor(source);

  useEffect(() => {
    thumbnailStore.register(doc, source);
    thumbnailStore.request(doc, page, width);
    return () => thumbnailStore.release(doc);
  }, [doc, source, page, width]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => thumbnailStore.setVisible(doc, page, width, entry.isIntersecting),
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [doc, page, width, ref]);

  return useSyncExternalStore(
    thumbnailStore.subscribe,
    () => thumbnailStore.getThumb(doc, page, width) ?? LOADING,
  );
}
