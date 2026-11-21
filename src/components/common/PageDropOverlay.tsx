import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { PAGE_ICONS } from "../../lib/pixelIcons";
import PixelIcon from "../brand/PixelIcon";
import { dragHasFiles, pageDragActive, setPageDragActive, subscribePageDrop } from "./pageDrop";

interface Props {
  /** Files dropped anywhere on the page (but not on another zone, which takes its own drop). */
  onFiles: (files: File[]) => void;
  /** Draw the full-page layer (one zone on the page); without it the zones light up themselves. */
  overlay: boolean;
}

/**
 * While files are dragged over the window, a full-page "Drop to open" layer; a drop anywhere hands
 * the files to `onFiles`. Drags without files (text, links, in-page cards) are ignored. Rendered by
 * the drop zone that leads (see `pageDrop.ts`), so the window listeners exist once; the drag state
 * is shared through `pageDrop.ts` so every zone can show it.
 */
export default function PageDropOverlay({ onFiles, overlay }: Props) {
  const t = useT("common");
  const visible = useSyncExternalStore(subscribePageDrop, pageDragActive, () => false);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    // dragenter/dragleave fire for every element crossed: count them so children do not flicker it.
    let depth = 0;
    const hide = () => {
      depth = 0;
      setPageDragActive(false);
    };
    const enter = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setPageDragActive(true);
    };
    const over = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setPageDragActive(false);
    };
    const drop = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      hide();
      // A drop the zone itself already took (its own handler prevented the default).
      if (e.defaultPrevented) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onFilesRef.current(files);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", hide);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", hide);
      window.removeEventListener("keydown", key);
      hide();
    };
  }, []);

  if (!overlay) return null;
  return createPortal(
    <div
      data-testid="page-drop-overlay"
      data-visible={visible ? "true" : undefined}
      aria-hidden="true"
      className={`fixed inset-0 z-[100] bg-paper p-4 transition-[opacity,visibility] duration-150 motion-reduce:transition-none sm:p-6 ${
        visible ? "visible opacity-100" : "invisible opacity-0"
      }`}
    >
      <div className="flex h-full flex-col items-center justify-center gap-6 border border-dashed border-ink px-4 text-center text-ink">
        <PixelIcon icon={PAGE_ICONS.fileUp} className="h-16 w-16 sm:h-24 sm:w-24" />
        <p className="font-display text-5xl font-light leading-none tracking-[-0.01em] sm:text-7xl">{t("dropOverlay")}</p>
      </div>
    </div>,
    document.body,
  );
}
