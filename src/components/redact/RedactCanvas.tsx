import { useEffect, useId, useRef, useState } from "react";
import PageImage from "../common/PageImage";
import {
  previewToVisiblePoint,
  rectFromPoints,
  resizeRect,
  visibleToPreviewRect,
  type BoxHandle,
  type Size,
} from "../../lib/editor/geometry";
import type { Mark, Rect } from "../../lib/redact/model";
import type { Fill } from "../../lib/redact/toJob";
import { placementPreviewSize } from "../../lib/signPlacement";
import { useT } from "../../i18n";

/** Same preview size as the Edit PDF canvas. */
const PREVIEW_WIDTH = 1000;
const PREVIEW_MAX_HEIGHT = 900;
/** Pointer travel (preview pixels) under which a press is a click, not a drag. */
const CLICK_PX = 4;
/** Hit area and drawn size of a resize handle, in preview pixels. */
const HANDLE_HIT = 24;
const HANDLE_SIZE = 10;

const HANDLES: readonly BoxHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_CURSOR: Record<BoxHandle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

/** A pointer gesture; `rect` is the live result (null until the pointer has moved enough). */
type Gesture =
  | { kind: "create"; start: [number, number]; startPx: [number, number]; dragged: boolean; rect: Rect | null }
  | { kind: "move"; id: string; start: [number, number]; base: Rect; rect: Rect | null }
  | { kind: "resize"; id: string; handle: BoxHandle; base: Rect; rect: Rect | null };

interface Props {
  source: Blob;
  /** 1-based page shown. */
  page: number;
  /** Visible page size in points (CropBox, /Rotate applied). */
  pageSize: Size;
  /** Marks of this page. */
  marks: readonly Mark[];
  fill: Fill;
  /** A redaction is running or waiting for its go-ahead: marks are shown but cannot change. */
  locked: boolean;
  selectedId: string | null;
  /** Rects to highlight briefly (a search match being shown). */
  flash?: readonly Rect[];
  onSelect: (id: string | null) => void;
  onAdd: (rect: Rect) => void;
  onUpdate: (id: string, rect: Rect) => void;
  onDelete: (id: string) => void;
}

/** Visible-space corner of a box handle. */
function handlePoint([x, y, w, h]: Rect, handle: BoxHandle): [number, number] {
  const px = handle.includes("w") ? x : handle.includes("e") ? x + w : x + w / 2;
  const py = handle.includes("s") ? y : handle.includes("n") ? y + h : y + h / 2;
  return [px, py];
}

/**
 * The page with its redaction marks as hatched boxes: drag on the page to mark an area, drag a
 * mark to move it, its handles to resize it (search matches too, to widen them).
 */
export default function RedactCanvas({ source, page, pageSize, marks, fill, locked, selectedId, flash = [], onSelect, onAdd, onUpdate, onDelete }: Props) {
  const t = useT("redact");
  const tc = useT("common");
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(PREVIEW_WIDTH);
  const gesture = useRef<Gesture | null>(null);
  // The rect being drawn, moved or resized, shown until the pointer is released.
  const [draft, setDraft] = useState<{ id: string | null; rect: Rect } | null>(null);
  const hatchId = useId();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width || PREVIEW_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A page switch abandons a gesture.
  useEffect(() => {
    gesture.current = null;
    setDraft(null);
  }, [page]);

  const preview: Size = placementPreviewSize(available, pageSize, PREVIEW_WIDTH, PREVIEW_MAX_HEIGHT);
  const [pw, ph] = preview;
  if (!(pageSize[0] > 0 && pageSize[1] > 0)) {
    return (
      <div ref={wrapRef} className="w-full">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t("noVisibleArea")}</p>
      </div>
    );
  }

  const pointerPx = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svgRef.current?.getBoundingClientRect();
    return r ? [e.clientX - r.left, e.clientY - r.top] : [0, 0];
  };
  const toVisible = (px: [number, number]) => previewToVisiblePoint(px, preview, pageSize);
  const box = (r: Rect) => visibleToPreviewRect(r, preview, pageSize);

  const areaMarks = marks.filter((m): m is Extract<Mark, { rect: Rect }> => m.kind !== "page");
  const wholePage = marks.some((m) => m.kind === "page");
  const rectOf = (m: Extract<Mark, { rect: Rect }>): Rect => (draft && draft.id === m.id ? draft.rect : m.rect);

  const begin = (e: React.PointerEvent, g: Gesture) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    svgRef.current?.setPointerCapture(e.pointerId);
    gesture.current = g;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const px = pointerPx(e);
    const p = toVisible(px);
    onSelect(null);
    begin(e, { kind: "create", start: p, startPx: px, dragged: false, rect: null });
  };

  const onMarkDown = (m: Extract<Mark, { rect: Rect }>) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    onSelect(m.id);
    begin(e, { kind: "move", id: m.id, start: toVisible(pointerPx(e)), base: m.rect, rect: null });
  };

  const onHandleDown = (m: Extract<Mark, { rect: Rect }>, handle: BoxHandle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    begin(e, { kind: "resize", id: m.id, handle, base: m.rect, rect: null });
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g) return;
    const px = pointerPx(e);
    const p = toVisible(px);
    // The live rect lives in the gesture (the release reads it there, not from a render).
    switch (g.kind) {
      case "create":
        if (Math.hypot(px[0] - g.startPx[0], px[1] - g.startPx[1]) >= CLICK_PX) g.dragged = true;
        if (g.dragged) g.rect = rectFromPoints(g.start, p);
        break;
      case "move": {
        const [x, y, w, h] = g.base;
        g.rect = [x + p[0] - g.start[0], y + p[1] - g.start[1], w, h];
        break;
      }
      case "resize":
        g.rect = resizeRect(g.base, g.handle, p, e.shiftKey);
        break;
    }
    if (g.rect) setDraft({ id: g.kind === "create" ? null : g.id, rect: g.rect });
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    setDraft(null);
    if (!g || !g.rect) return;
    if (g.kind === "create") {
      if (g.dragged && g.rect[2] > 0 && g.rect[3] > 0) onAdd(g.rect);
      return;
    }
    onUpdate(g.id, g.rect);
  };

  const cancel = () => {
    gesture.current = null;
    setDraft(null);
  };

  const stroke = fill === "white" ? "#4b5563" : "#111827";
  const hatch = fill === "white" ? "#9ca3af" : "#111827";
  const selected = areaMarks.find((m) => m.id === selectedId) ?? null;

  return (
    <div ref={wrapRef} className="w-full">
      <div
        ref={rootRef}
        role="application"
        aria-roledescription={t("canvasRole")}
        aria-label={t("canvasLabel", { page })}
        aria-describedby="redact-canvas-help"
        tabIndex={0}
        data-testid="redact-canvas"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Cancels a gesture (a mark being drawn, too), else deselects.
            if (gesture.current) {
              e.preventDefault();
              cancel();
            } else if (selected) {
              e.preventDefault();
              onSelect(null);
            }
            return;
          }
          if (!selected || locked) return;
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            onDelete(selected.id);
          }
        }}
        className="relative mx-auto select-none overflow-hidden rounded-lg border border-gray-300 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-mantis-500 dark:border-[#333]"
        style={{ width: pw, height: ph }}
      >
        <PageImage source={source} page={page} width={PREVIEW_WIDTH} alt={tc("pageN", { n: page })} className="h-full" />
        <svg
          ref={svgRef}
          className="absolute inset-0 touch-none"
          width={pw}
          height={ph}
          viewBox={`0 0 ${pw} ${ph}`}
          style={{ cursor: locked ? "not-allowed" : "crosshair" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancel}
        >
          <defs>
            <pattern id={hatchId} width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={8} height={8} fill={fill === "white" ? "rgba(255,255,255,0.55)" : "rgba(17,24,39,0.18)"} />
              <line x1={0} y1={0} x2={0} y2={8} stroke={hatch} strokeWidth={2} />
            </pattern>
          </defs>
          {wholePage && (
            <rect
              data-mark="page"
              x={1}
              y={1}
              width={pw - 2}
              height={ph - 2}
              fill={`url(#${hatchId})`}
              stroke={stroke}
              strokeWidth={2}
              pointerEvents="none"
            />
          )}
          {areaMarks.map((m) => {
            const b = box(rectOf(m));
            return (
              <rect
                key={m.id}
                data-mark={m.kind}
                x={b.left}
                y={b.top}
                width={Math.max(b.width, 1)}
                height={Math.max(b.height, 1)}
                fill={`url(#${hatchId})`}
                stroke={stroke}
                strokeWidth={m.id === selectedId ? 2.5 : 1.5}
                style={{ cursor: "move" }}
                onPointerDown={onMarkDown(m)}
              >
                <title>{m.kind === "search" ? t("searchMatch", { query: m.query }) : t("markArea")}</title>
              </rect>
            );
          })}
          {flash.map((r, i) => {
            const b = box(r);
            return (
              <rect
                key={`flash-${i}`}
                data-flash="true"
                x={b.left - 3}
                y={b.top - 3}
                width={b.width + 6}
                height={b.height + 6}
                fill="rgba(250, 204, 21, 0.35)"
                stroke="#ca8a04"
                strokeWidth={2}
                rx={2}
                pointerEvents="none"
                className="motion-safe:animate-pulse"
              />
            );
          })}
          {draft && draft.id === null && (() => {
            const b = box(draft.rect);
            return <rect x={b.left} y={b.top} width={b.width} height={b.height} fill={`url(#${hatchId})`} stroke={stroke} strokeDasharray="4 3" pointerEvents="none" />;
          })()}
          {selected &&
            !locked &&
            HANDLES.map((handle) => {
              const r = rectOf(selected);
              const b = box([...handlePoint(r, handle), 0, 0] as Rect);
              return (
                <g key={handle} data-handle={handle} style={{ cursor: HANDLE_CURSOR[handle] }} onPointerDown={onHandleDown(selected, handle)}>
                  <rect x={b.left - HANDLE_HIT / 2} y={b.top - HANDLE_HIT / 2} width={HANDLE_HIT} height={HANDLE_HIT} fill="transparent" />
                  <rect
                    x={b.left - HANDLE_SIZE / 2}
                    y={b.top - HANDLE_SIZE / 2}
                    width={HANDLE_SIZE}
                    height={HANDLE_SIZE}
                    rx={2}
                    fill="#16a34a"
                    stroke="#fff"
                    strokeWidth={1.5}
                    pointerEvents="none"
                  />
                </g>
              );
            })}
        </svg>
      </div>
      <p id="redact-canvas-help" className="mt-2 text-center text-xs text-gray-500 dark:text-[#777]">
        {t("canvasHelp")}
      </p>
    </div>
  );
}
