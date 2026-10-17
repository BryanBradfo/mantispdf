import { useEffect, useRef, useState } from "react";
import PageImage from "../common/PageImage";
import {
  clampVisibleRect,
  placementPreviewSize,
  previewToVisibleRect,
  visibleToPreviewRect,
  type PreviewBox,
  type Size,
  type VisibleRect,
} from "../../lib/signPlacement";

/** Render width of the page preview (also its maximum on-screen width). */
const PREVIEW_WIDTH = 560;
/** Maximum on-screen height: a very tall page is shown narrower instead. */
const PREVIEW_MAX_HEIGHT = 800;
/** Smallest signature width while resizing, in preview pixels. */
const MIN_BOX = 16;

interface Props {
  source: Blob | Uint8Array;
  /** 1-based page shown. */
  page: number;
  /** Visible page size in points (CropBox, /Rotate applied). */
  pageSize: Size;
  signatureUrl: string;
  /** Signature box in visible space. */
  rect: VisibleRect;
  onRect: (rect: VisibleRect) => void;
  /** Optional caption drawn at a visible-space baseline origin, to preview the "Signed on" line. */
  caption?: { text: string; at: [number, number]; size: number } | null;
}

type Gesture = { kind: "move" | "resize"; pointerX: number; pointerY: number; start: PreviewBox };

export default function PlacementCanvas({ source, page, pageSize, signatureUrl, rect, onRect, caption }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(PREVIEW_WIDTH);
  const gesture = useRef<Gesture | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width || PREVIEW_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [vw, vh] = pageSize;
  const preview: Size = placementPreviewSize(available, pageSize, PREVIEW_WIDTH, PREVIEW_MAX_HEIGHT);
  const [pw, ph] = preview;
  const degenerate = !(vw > 0 && vh > 0);
  const box = visibleToPreviewRect(rect, preview, pageSize);
  const aspect = rect[2] / rect[3];

  const begin = (kind: Gesture["kind"]) => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { kind, pointerX: e.clientX, pointerY: e.clientY, start: box };
  };

  const move = (e: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.pointerX;
    const dy = e.clientY - g.pointerY;
    let next: PreviewBox;
    if (g.kind === "move") {
      next = { ...g.start, left: g.start.left + dx, top: g.start.top + dy };
    } else {
      // Bottom-right corner: the top-left stays put, the aspect ratio is kept.
      const maxW = Math.min(pw - g.start.left, (ph - g.start.top) * aspect);
      const width = Math.max(MIN_BOX, Math.min(maxW, g.start.width + Math.max(dx, dy * aspect)));
      next = { ...g.start, width, height: width / aspect };
    }
    onRect(clampVisibleRect(previewToVisibleRect(next, preview, pageSize), pageSize));
  };

  const end = () => {
    gesture.current = null;
  };

  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
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
    const [x, y, w, h] = rect;
    onRect(clampVisibleRect([x + d[0], y + d[1], w, h], pageSize));
  };

  if (degenerate) {
    // Same root element as below, so the ResizeObserver keeps watching it.
    return (
      <div ref={wrapRef} className="w-full max-w-[560px]">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">This page has no visible area to sign on.</p>
      </div>
    );
  }

  const scale = pw / vw;
  return (
    <div ref={wrapRef} className="w-full max-w-[560px]">
      <div
        className="relative select-none overflow-hidden rounded-lg border border-gray-300 shadow-sm dark:border-[#333]"
        style={{ width: pw, height: ph }}
      >
        <PageImage source={source} page={page} width={PREVIEW_WIDTH} alt={`Page ${page}`} className="h-full" />
        {caption && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute whitespace-nowrap leading-none text-gray-700"
            style={{
              left: caption.at[0] * scale,
              top: ph - (caption.at[1] + caption.size * 0.72) * scale,
              fontSize: caption.size * scale,
              fontFamily: "Helvetica, Arial, sans-serif",
            }}
          >
            {caption.text}
          </span>
        )}
        <div
          role="group"
          aria-roledescription="movable signature"
          aria-label="Signature position"
          aria-describedby="signature-position-help"
          tabIndex={0}
          onPointerDown={begin("move")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={key}
          className="absolute cursor-move touch-none outline-none ring-1 ring-mantis-500/70 hover:ring-2 focus-visible:ring-2 focus-visible:ring-mantis-600"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        >
          <img src={signatureUrl} alt="" draggable={false} className="pointer-events-none h-full w-full" />
          <span
            aria-hidden="true"
            onPointerDown={begin("resize")}
            className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-mantis-600"
          />
        </div>
      </div>
      <p id="signature-position-help" className="mt-2 text-xs text-gray-500 dark:text-[#777]">
        Drag the signature to move it, drag its corner to resize. Arrow keys move it by 1 pt (Shift: 10 pt).
      </p>
    </div>
  );
}
