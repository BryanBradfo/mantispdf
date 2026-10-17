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

/**
 * Where each handle's center sits on the box, and its cursor. The handle is a 24 px hit area
 * centered there (the visible dot is smaller).
 */
const HANDLE_STYLE: Record<Handle, string> = {
  nw: "left-0 top-0 cursor-nwse-resize",
  n: "left-1/2 top-0 cursor-ns-resize",
  ne: "left-full top-0 cursor-nesw-resize",
  e: "left-full top-1/2 cursor-ew-resize",
  se: "left-full top-full cursor-nwse-resize",
  s: "left-1/2 top-full cursor-ns-resize",
  sw: "left-0 top-full cursor-nesw-resize",
  w: "left-0 top-1/2 cursor-ew-resize",
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

  // Same convention as the signature placement: arrows move by 1 pt, Shift+arrows by 10 pt;
  // Ctrl (or Cmd) resizes from the bottom-right corner instead. Alt is left to the browser.
  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey) return;
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    // Resizing moves the bottom-right corner: Right/Down grow the box, Left/Up shrink it.
    const resize = e.ctrlKey || e.metaKey;
    const next = resize ? resizeCropRect(rect, "se", d[0], d[1], pageSize) : moveCropRect(rect, d[0], d[1], pageSize);
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
      <div data-crop-frame className="relative select-none" style={{ width: pw, height: ph }}>
        <div className="absolute inset-0 overflow-hidden rounded-lg border border-gray-300 shadow-sm dark:border-[#333]">
          <PageImage source={source} page={page} width={PREVIEW_WIDTH} alt={`Page ${page}`} className="h-full" />
          {/* Dims everything outside the box; the frame clips the shadow. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height, boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.45)" }}
          />
        </div>
        {/* Outside the clipping frame, so the handles on the page edge stay whole and grabbable. */}
        <div className="absolute inset-px">
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
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          >
            {HANDLES.map((h) => (
              <span
                key={h}
                aria-hidden="true"
                data-handle={h}
                onPointerDown={begin(h)}
                className={`absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center ${HANDLE_STYLE[h]}`}
              >
                <span className="h-3 w-3 rounded-sm border border-white bg-mantis-600" />
              </span>
            ))}
          </div>
        </div>
      </div>
      <p id="crop-area-help" className="mt-2 text-xs text-gray-500 dark:text-[#777]">
        Drag the box to move it, drag a handle to resize it. Arrow keys move it by 1 pt (Shift+arrows by 10 pt);
        Ctrl+arrows (Cmd on a Mac) resize it from the bottom-right corner by 1 pt, Ctrl+Shift+arrows by 10 pt.
      </p>
      <p className="sr-only" aria-live="polite">{spoken}</p>
    </div>
  );
}
