import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { pdfjsRenderer } from "./pdfjsRenderer";
import { LOADING, ThumbnailStore, docKeyFor } from "./store";
import type { RenderMode, ThumbState } from "./types";

export const thumbnailStore = new ThumbnailStore(pdfjsRenderer);
export { docKeyFor };
export type { RenderMode, ThumbState };

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
  mode: RenderMode = "full",
): ThumbState {
  const doc = docKeyFor(source);

  useEffect(() => {
    thumbnailStore.register(doc, source);
    thumbnailStore.request(doc, page, width, mode);
    return () => thumbnailStore.release(doc);
  }, [doc, source, page, width, mode]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => thumbnailStore.setVisible(doc, page, width, entry.isIntersecting, mode),
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [doc, page, width, ref, mode]);

  return useSyncExternalStore(
    thumbnailStore.subscribe,
    () => thumbnailStore.getThumb(doc, page, width, mode) ?? LOADING,
  );
}
