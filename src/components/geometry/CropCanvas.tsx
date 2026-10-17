import { useEffect, useRef, useState } from "react";
import PageImage from "../common/PageImage";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { placementPreviewSize, visibleToPreviewRect, type Size } from "../../lib/signPlacement";
import { HANDLES, describeCrop, moveCropRect, resizeCropRect, type Handle } from "../../lib/cropBox";
import type { Rect } from "../../lib/geometryJob";

/** Render width of the page preview (also its maximum on-screen width). */
const PREVIEW_WIDTH = 560;
/** Maximum on-screen height: a very tall page is shown narrower instead. */
const PREVIEW_MAX_HEIGHT = 800;
/** Pause after the last key before the new box is announced. */
const ANNOUNCE_DELAY_MS = 500;

/** Where each handle sits on the box, and its cursor. */
const HANDLE_STYLE: Record<Handle, string> = {
  nw: "-left-1.5 -top-1.5 cursor-nwse-resize",
  n: "left-1/2 -top-1.5 -ml-1.5 cursor-ns-resize",
  ne: "-right-1.5 -top-1.5 cursor-nesw-resize",
  e: "-right-1.5 top-1/2 -mt-1.5 cursor-ew-resize",
  se: "-bottom-1.5 -right-1.5 cursor-nwse-resize",
  s: "left-1/2 -bottom-1.5 -ml-1.5 cursor-ns-resize",
  sw: "-bottom-1.5 -left-1.5 cursor-nesw-resize",
  w: "-left-1.5 top-1/2 -mt-1.5 cursor-ew-resize",
};

interface Props {
  source: Blob | Uint8Array;
  /** 1-based page shown. */
  page: number;
  /** Visible page size in points (CropBox, /Rotate applied). */
  pageSize: Size;
  /** Crop box in visible space, already on the page. */
  rect: Rect;
  onRect: (rect: Rect) => void;
}

type Gesture = { handle: Handle | "move"; pointerX: number; pointerY: number; start: Rect };

export default function CropCanvas({ source, page, pageSize, rect, onRect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(PREVIEW_WIDTH);
  const gesture = useRef<Gesture | null>(null);
  // Set by keyboard moves and resizes only; read out once the keys pause.
  const [announcement, setAnnouncement] = useState("");
  const spoken = useDebouncedValue(announcement, ANNOUNCE_DELAY_MS);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width || PREVIEW_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [vw, vh] = pageSize;
  const preview = placementPreviewSize(available, pageSize, PREVIEW_WIDTH, PREVIEW_MAX_HEIGHT);
  const [pw, ph] = preview;
  const degenerate = !(vw > 0 && vh > 0);
  const box = visibleToPreviewRect(rect, preview, pageSize);

  const begin = (handle: Gesture["handle"]) => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { handle, pointerX: e.clientX, pointerY: e.clientY, start: rect };
  };

  const move = (e: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g) return;
    // Preview pixels to points; screen y grows downwards, visible y upwards.
    const dx = ((e.clientX - g.pointerX) * vw) / pw;
    const dy = (-(e.clientY - g.pointerY) * vh) / ph;
    onRect(g.handle === "move" ? moveCropRect(g.start, dx, dy, pageSize) : resizeCropRect(g.start, g.handle, dx, dy, pageSize));
  };

  const end = () => {
    gesture.current = null;
  };

  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.altKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    // Shift resizes from the bottom-right corner: Right/Down grow the box, Left/Up shrink it.
    const next = e.shiftKey ? resizeCropRect(rect, "se", d[0], d[1], pageSize) : moveCropRect(rect, d[0], d[1], pageSize);
    onRect(next);
    setAnnouncement(describeCrop(next, pageSize));
  };

  if (degenerate) {
    // Same root element as below, so the ResizeObserver keeps watching it.
    return (
      <div ref={wrapRef} className="w-full max-w-[560px]">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">This page has no visible area to crop.</p>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="w-full max-w-[560px]">
      <div
        className="relative select-none overflow-hidden rounded-lg border border-gray-300 shadow-sm dark:border-[#333]"
        style={{ width: pw, height: ph }}
      >
        <PageImage source={source} page={page} width={PREVIEW_WIDTH} alt={`Page ${page}`} className="h-full" />
        <div
          role="group"
          aria-roledescription="resizable crop box"
          aria-label="Crop area"
          aria-describedby="crop-area-help"
          tabIndex={0}
          onPointerDown={begin("move")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={key}
          className="absolute cursor-move touch-none outline-none ring-2 ring-mantis-500 focus-visible:ring-4 focus-visible:ring-mantis-600"
          // The shadow dims everything outside the box (the frame clips it).
          style={{ left: box.left, top: box.top, width: box.width, height: box.height, boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.45)" }}
        >
          {HANDLES.map((h) => (
            <span
              key={h}
              aria-hidden="true"
              data-handle={h}
              onPointerDown={begin(h)}
              className={`absolute h-3 w-3 rounded-sm border border-white bg-mantis-600 ${HANDLE_STYLE[h]}`}
            />
          ))}
        </div>
      </div>
      <p id="crop-area-help" className="mt-2 text-xs text-gray-500 dark:text-[#777]">
        Drag the box to move it, drag a handle to resize it. Arrow keys move it by 1 pt, Shift+arrows resize it from the
        bottom-right corner (hold Alt for 10 pt).
      </p>
      <p className="sr-only" aria-live="polite">{spoken}</p>
    </div>
  );
}
