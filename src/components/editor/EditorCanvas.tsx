import { useEffect, useRef, useState, type Dispatch } from "react";
import PageImage from "../common/PageImage";
import { charUnits } from "../../lib/editor/afm";
import {
  HIT_SLOP,
  handlePositions,
  hitTestItems,
  itemBounds,
  previewToVisiblePoint,
  visibleToPreviewPoint,
  visibleToPreviewRect,
  type Handle,
  type Size,
} from "../../lib/editor/geometry";
import type { ImageSource, Item, NewItem, Point } from "../../lib/editor/model";
import type { EditorAction } from "../../lib/editor/reducer";
import { simplifyStroke } from "../../lib/editor/simplify";
import { BLACK, createItem } from "../../lib/editor/create";
import { layoutText } from "../../lib/editor/wrap";
import { placementPreviewSize } from "../../lib/signPlacement";
import { cssColor, cssFont } from "./svgStyle";
import TextEditOverlay from "./TextEditOverlay";
import NotoText from "./NotoText";
import { resolveFont } from "../../lib/editor/unicodeText";
import { TOOLS, type Tool } from "./Toolbar";

/** Render width of the page preview (also its maximum on-screen width). */
const PREVIEW_WIDTH = 1000;
/** Maximum on-screen height: a tall page is shown narrower instead. */
const PREVIEW_MAX_HEIGHT = 900;
/** Pointer travel (preview pixels) under which a press is a click, not a drag. */
const CLICK_PX = 4;
/** Hit area of a resize handle, in preview pixels. */
const HANDLE_HIT = 24;
const HANDLE_SIZE = 10;


/** Consecutive arrow-key nudges of one item closer together than this are one undo step. */
const NUDGE_IDLE_MS = 500;

/** Tools that stay active after creating an item (several strokes in a row are common). */
const STICKY_TOOLS: ReadonlySet<Tool> = new Set(["draw", "highlight"]);

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  from: "move",
  to: "move",
};

type Gesture =
  | { kind: "move"; id: string; last: Point }
  | { kind: "resize"; id: string; handle: Handle }
  | { kind: "create"; tool: Tool; start: Point; startPx: Point; current: Point; dragged: boolean }
  | { kind: "draw"; points: Point[] };

interface Props {
  source: Blob;
  /** 1-based page shown. */
  page: number;
  /** Visible page size in points (CropBox, /Rotate applied). */
  pageSize: Size;
  /** Every item of the document (only this page's are drawn). */
  items: readonly Item[];
  selectedId: string | null;
  /** Text box whose content is being typed, if any. */
  editingId: string | null;
  tool: Tool;
  /** Image picked with the Image tool, waiting to be placed. */
  pendingImage: ImageSource | null;
  imageUrl: (blob: Blob) => string;
  dispatch: Dispatch<EditorAction>;
  /** Adds an item unless a limit refuses it (the page shows why); true when added. */
  onCreate: (item: NewItem) => boolean;
  /** Duplicates an item unless a limit refuses it (same checks as `onCreate`). */
  onDuplicate: (id: string) => void;
  onTool: (tool: Tool) => void;
  onPickImage: () => void;
  onEditText: (id: string | null) => void;
  onCommitText: (id: string, text: string) => void;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** Width of a laid-out line in points, from the AFM metrics (unsupported characters count 0). */
function lineWidth(text: string, font: Parameters<typeof charUnits>[0], size: number): number {
  let units = 0;
  for (const ch of text) units += charUnits(font, ch);
  return (units * size) / 1000;
}

/** Arrowhead triangle (tip first), the engine's `arrow_head`. */
function arrowHead(tip: Point, u: Point, width: number): Point[] {
  const l = 3 * width + 6;
  const h = l * Math.tan((25 * Math.PI) / 180);
  const n: Point = [-u[1], u[0]];
  const base: Point = [tip[0] - l * u[0], tip[1] - l * u[1]];
  return [tip, [base[0] + h * n[0], base[1] + h * n[1]], [base[0] - h * n[0], base[1] - h * n[1]]];
}

export default function EditorCanvas(props: Props) {
  const { source, page, pageSize, items, selectedId, editingId, tool, pendingImage, imageUrl, dispatch } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [available, setAvailable] = useState(PREVIEW_WIDTH);
  const gesture = useRef<Gesture | null>(null);
  // The in-progress shape or stroke, drawn until the pointer is released.
  const [draft, setDraft] = useState<Gesture | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width || PREVIEW_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const preview: Size = placementPreviewSize(available, pageSize, PREVIEW_WIDTH, PREVIEW_MAX_HEIGHT);
  const [pw, ph] = preview;
  const degenerate = !(pageSize[0] > 0 && pageSize[1] > 0);
  const scale = pw / pageSize[0];
  const pageItems = items.filter((it) => it.page === page);
  const selected = pageItems.find((it) => it.id === selectedId) ?? null;
  const editing = pageItems.find((it) => it.id === editingId && it.kind === "text") ?? null;

  const toPx = (p: Point): Point => visibleToPreviewPoint(p, preview, pageSize);
  const pointerPx = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current?.getBoundingClientRect();
    return r ? [e.clientX - r.left, e.clientY - r.top] : [0, 0];
  };
  const toVisible = (px: Point): Point => previewToVisiblePoint(px, preview, pageSize);

  /**
   * Abandon the pointer gesture: a half-made shape is dropped; a move or resize is reverted
   * (`revert`, Escape) or kept as one undo step.
   */
  const cancelGesture = (revert = false) => {
    const g = gesture.current;
    gesture.current = null;
    setDraft(null);
    if (g?.kind === "move" || g?.kind === "resize") dispatch({ type: revert ? "cancelGesture" : "endGesture" });
  };

  // Arrow-key nudges of one item are grouped into one undo step: the group ends after
  // `NUDGE_IDLE_MS` without a nudge, or before any other key or pointer action. (Not on keyup:
  // each tap is a keydown + keyup, so that would make every tap its own step.)
  const nudging = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const endNudge = () => {
    const n = nudging.current;
    if (!n) return;
    clearTimeout(n.timer);
    nudging.current = null;
    dispatch({ type: "endGesture" });
  };
  const nudge = (id: string, dx: number, dy: number) => {
    if (nudging.current && nudging.current.id !== id) endNudge();
    if (!nudging.current) {
      dispatch({ type: "beginGesture" });
      nudging.current = { id, timer: setTimeout(endNudge, NUDGE_IDLE_MS) };
    } else {
      clearTimeout(nudging.current.timer);
      nudging.current.timer = setTimeout(endNudge, NUDGE_IDLE_MS);
    }
    dispatch({ type: "move", id, dx, dy });
  };
  const endNudgeRef = useRef(endNudge);
  endNudgeRef.current = endNudge;
  useEffect(() => {
    const end = () => endNudgeRef.current();
    document.addEventListener("pointerdown", end, true);
    window.addEventListener("blur", end);
    return () => {
      document.removeEventListener("pointerdown", end, true);
      window.removeEventListener("blur", end);
      end();
    };
  }, []);

  /** The new item of a creation gesture (drag rect or a click default). */
  const buildItem = (g: Extract<Gesture, { kind: "create" }>): NewItem | null =>
    g.tool === "select" || g.tool === "draw"
      ? null
      : createItem({ tool: g.tool, page, start: g.start, current: g.current, dragged: g.dragged, pageSize, image: pendingImage });

  const finishCreate = (item: NewItem | null, from: Tool) => {
    if (!item) return;
    if (!props.onCreate(item)) return;
    if (!STICKY_TOOLS.has(from)) props.onTool("select");
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || gesture.current) return;
    e.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    const px = pointerPx(e);
    const p = toVisible(px);
    e.currentTarget.setPointerCapture(e.pointerId);
    const slop = Math.max(HIT_SLOP, 6 / scale);

    if (tool === "select" || tool === "text") {
      const hit = hitTestItems(items, page, p, slop);
      if (hit && (tool === "select" || hit.kind === "text")) {
        dispatch({ type: "select", id: hit.id });
        if (tool === "text") {
          props.onEditText(hit.id);
          return;
        }
        dispatch({ type: "beginGesture" });
        gesture.current = { kind: "move", id: hit.id, last: p };
        return;
      }
      if (tool === "select") {
        dispatch({ type: "select", id: null });
        return;
      }
    }
    if (tool === "image" && !pendingImage) {
      props.onPickImage();
      return;
    }
    if (tool === "draw") {
      const g: Gesture = { kind: "draw", points: [p] };
      gesture.current = g;
      setDraft({ ...g });
      return;
    }
    const g: Gesture = { kind: "create", tool, start: p, startPx: px, current: p, dragged: false };
    gesture.current = g;
    setDraft(g);
  };

  const onHandleDown = (handle: Handle) => (e: React.PointerEvent<SVGGElement>) => {
    if (e.button !== 0 || !selected || tool !== "select") return;
    e.preventDefault();
    e.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    svgRef.current?.setPointerCapture(e.pointerId);
    dispatch({ type: "beginGesture" });
    gesture.current = { kind: "resize", id: selected.id, handle };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g) return;
    const px = pointerPx(e);
    const p = toVisible(px);
    switch (g.kind) {
      case "move": {
        dispatch({ type: "move", id: g.id, dx: p[0] - g.last[0], dy: p[1] - g.last[1] });
        g.last = p;
        return;
      }
      case "resize":
        dispatch({ type: "resize", id: g.id, handle: g.handle, point: p, keepAspect: e.shiftKey });
        return;
      case "draw": {
        const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
        const list = events.length > 0 ? events : [e.nativeEvent];
        for (const ev of list) g.points.push(toVisible(pointerPx(ev)));
        setDraft({ kind: "draw", points: g.points });
        return;
      }
      case "create": {
        g.current = p;
        if (Math.hypot(px[0] - g.startPx[0], px[1] - g.startPx[1]) >= CLICK_PX) g.dragged = true;
        setDraft({ ...g });
        return;
      }
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    setDraft(null);
    if (!g) return;
    switch (g.kind) {
      case "move":
      case "resize":
        dispatch({ type: "endGesture" });
        return;
      case "draw": {
        const points = simplifyStroke(g.points.length === 1 ? [g.points[0], g.points[0]] : g.points);
        finishCreate({ kind: "freehand", page, points, color: BLACK, width: 2, opacity: 1 }, "draw");
        return;
      }
      case "create":
        finishCreate(buildItem(g), g.tool);
        return;
    }
  };

  // Keyboard: shortcuts work anywhere on the page except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target)) return;
      // A text box is being typed into (its textarea may not have focus yet): keys are text.
      if (editingId !== null) return;
      // Mid-drag only Escape applies: no tool switch, undo or redo under the pointer.
      if (gesture.current && e.key !== "Escape") return;
      // Bare modifiers (Shift for 10 pt steps) do not end a nudge group.
      const modifier = e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta";
      if (nudging.current && !modifier && !e.key.startsWith("Arrow")) endNudge();
      const key = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (e.altKey) return;
        if (key === "z" && !e.shiftKey) dispatch({ type: "undo" });
        else if ((key === "z" && e.shiftKey) || key === "y") dispatch({ type: "redo" });
        else if (key === "d" && selected) props.onDuplicate(selected.id);
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;
      if (e.key === "Escape") {
        if (gesture.current) cancelGesture(true);
        else if (selectedId) dispatch({ type: "select", id: null });
        else if (tool !== "select") props.onTool("select");
        else return;
        e.preventDefault();
        return;
      }
      // Item keys only when the canvas (or nothing in particular) has focus.
      const target = e.target as Node | null;
      const onCanvas = target === document.body || (target !== null && rootRef.current?.contains(target) === true);
      if (onCanvas && selected && !gesture.current) {
        const step = e.shiftKey ? 10 : 1;
        const arrows: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, step],
          ArrowDown: [0, -step],
        };
        const d = arrows[e.key];
        if (d) {
          e.preventDefault();
          nudge(selected.id, d[0], d[1]);
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          dispatch({ type: "delete", id: selected.id });
          return;
        }
        if (e.key === "Enter" && selected.kind === "text") {
          e.preventDefault();
          props.onEditText(selected.id);
          return;
        }
      }
      if (e.shiftKey || e.repeat) return;
      const info = TOOLS.find((t) => t.key === key);
      if (!info) return;
      e.preventDefault();
      if (info.tool === "image") props.onPickImage();
      else props.onTool(info.tool);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // A page switch or tool change abandons a half-made shape (a move or resize is kept).
  useEffect(() => {
    cancelGesture();
  }, [page, tool]);

  if (degenerate) {
    return (
      <div ref={wrapRef} className="w-full">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">This page has no visible area to edit.</p>
      </div>
    );
  }

  const renderItem = (it: Item) => {
    switch (it.kind) {
      case "text": {
        if (it.id === editingId) return null;
        const box = visibleToPreviewRect(it.rect, preview, pageSize);
        const resolved = resolveFont(it.font, it.text);
        if (resolved.kind === "noto") {
          return <NotoText key={it.id} item={it} family={resolved.family} bold={resolved.bold} toPx={toPx} scale={scale} box={box} />;
        }
        const font = resolved.font;
        const { family, weight } = cssFont(font);
        // Standard fonts only for WinAnsi text (other text resolved to Noto above): nothing to flag.
        return (
          <g key={it.id}>
            <g opacity={it.opacity} fill={cssColor(it.color)} fontFamily={family} fontWeight={weight} fontSize={it.size * scale}>
              {layoutText(it.rect, it.text, font, it.size, it.align === "auto" ? "left" : it.align, it.lineHeight).map((line, i) => {
                const [x, y] = toPx([line.x, line.y]);
                const width = lineWidth(line.text, font, it.size) * scale;
                return (
                  <text key={i} x={x} y={y} style={{ whiteSpace: "pre" }} {...(width > 0 ? { textLength: width, lengthAdjust: "spacingAndGlyphs" } : {})}>
                    {line.text}
                  </text>
                );
              })}
            </g>
          </g>
        );
      }
      case "image": {
        const b = visibleToPreviewRect(it.rect, preview, pageSize);
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        const quarter = it.rotation === 90 || it.rotation === 270;
        const w = quarter ? b.height : b.width;
        const h = quarter ? b.width : b.height;
        return (
          <image
            key={it.id}
            href={imageUrl(it.image.blob)}
            x={cx - w / 2}
            y={cy - h / 2}
            width={w}
            height={h}
            preserveAspectRatio="none"
            opacity={it.opacity}
            transform={it.rotation ? `rotate(${it.rotation} ${cx} ${cy})` : undefined}
          />
        );
      }
      case "rect":
      case "ellipse": {
        const b = visibleToPreviewRect(it.rect, preview, pageSize);
        const paint = {
          fill: it.fill.kind === "rgb" ? cssColor(it.fill.color) : "none",
          stroke: it.stroke.kind === "rgb" && it.width > 0 ? cssColor(it.stroke.color) : "none",
          strokeWidth: it.width * scale,
          opacity: it.opacity,
        };
        return it.kind === "rect" ? (
          <rect key={it.id} x={b.left} y={b.top} width={b.width} height={b.height} {...paint} />
        ) : (
          <ellipse key={it.id} cx={b.left + b.width / 2} cy={b.top + b.height / 2} rx={b.width / 2} ry={b.height / 2} {...paint} />
        );
      }
      case "line": {
        const len = Math.hypot(it.to[0] - it.from[0], it.to[1] - it.from[1]);
        const color = cssColor(it.color);
        if (len === 0) return null;
        const u: Point = [(it.to[0] - it.from[0]) / len, (it.to[1] - it.from[1]) / len];
        const cut = 0.8 * (3 * it.width + 6);
        const cs = it.arrowStart ? cut : 0;
        const ce = it.arrowEnd ? cut : 0;
        const a = toPx([it.from[0] + cs * u[0], it.from[1] + cs * u[1]]);
        const b = toPx([it.to[0] - ce * u[0], it.to[1] - ce * u[1]]);
        const head = (tip: Point, dir: Point) =>
          arrowHead(tip, dir, it.width)
            .map((q) => toPx(q).join(","))
            .join(" ");
        return (
          <g key={it.id} opacity={it.opacity}>
            {cs + ce < len && <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color} strokeWidth={it.width * scale} />}
            {it.arrowStart && <polygon points={head(it.from, [-u[0], -u[1]])} fill={color} />}
            {it.arrowEnd && <polygon points={head(it.to, u)} fill={color} />}
          </g>
        );
      }
      case "highlight": {
        const b = visibleToPreviewRect(it.rect, preview, pageSize);
        return (
          <rect
            key={it.id}
            x={b.left}
            y={b.top}
            width={b.width}
            height={b.height}
            fill={cssColor(it.color)}
            opacity={it.opacity}
            style={{ mixBlendMode: "multiply" }}
          />
        );
      }
      case "freehand":
        return (
          <polyline
            key={it.id}
            points={it.points.map((q) => toPx(q).join(",")).join(" ")}
            fill="none"
            stroke={cssColor(it.color)}
            strokeWidth={it.width * scale}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={it.opacity}
          />
        );
      case "whiteout": {
        const b = visibleToPreviewRect(it.rect, preview, pageSize);
        return <rect key={it.id} x={b.left} y={b.top} width={b.width} height={b.height} fill="#fff" />;
      }
    }
  };

  const renderDraft = () => {
    if (!draft) return null;
    if (draft.kind === "draw") {
      return (
        <polyline
          points={draft.points.map((q) => toPx(q).join(",")).join(" ")}
          fill="none"
          stroke={cssColor(BLACK)}
          strokeWidth={2 * scale}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
    if (draft.kind !== "create" || !draft.dragged) return null;
    const item = buildItem(draft);
    if (!item) return null;
    const draftItem = { ...item, id: "draft" } as Item;
    const b = visibleToPreviewRect(itemBounds(draftItem), preview, pageSize);
    return (
      <g pointerEvents="none">
        <g opacity={0.7}>{renderItem(draftItem)}</g>
        {item.kind !== "line" && (
          <rect x={b.left} y={b.top} width={b.width} height={b.height} fill="none" stroke="#16a34a" strokeWidth={1} strokeDasharray="4 3" />
        )}
      </g>
    );
  };

  const renderSelection = () => {
    if (!selected || selected.id === editingId) return null;
    // Handles only with the Select tool: with a drawing tool a press near the selection creates.
    const handles = tool === "select" ? handlePositions(selected) : [];
    const outline =
      selected.kind === "line" ? null : (() => {
        const b = visibleToPreviewRect(itemBounds(selected), preview, pageSize);
        return (
          <rect
            x={b.left}
            y={b.top}
            width={Math.max(b.width, 1)}
            height={Math.max(b.height, 1)}
            fill="none"
            stroke="#16a34a"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        );
      })();
    return (
      <g>
        {outline}
        {handles.map(({ handle, point }) => {
          const [x, y] = toPx(point);
          return (
            <g key={handle} onPointerDown={onHandleDown(handle)} style={{ cursor: HANDLE_CURSOR[handle] }} data-handle={handle}>
              <rect x={x - HANDLE_HIT / 2} y={y - HANDLE_HIT / 2} width={HANDLE_HIT} height={HANDLE_HIT} fill="transparent" />
              <rect
                x={x - HANDLE_SIZE / 2}
                y={y - HANDLE_SIZE / 2}
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
      </g>
    );
  };

  const cursor = tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";
  const toolLabel = TOOLS.find((t) => t.tool === tool)?.label ?? "Select";

  return (
    <div ref={wrapRef} className="w-full">
      <div
        ref={rootRef}
        role="application"
        aria-roledescription="page editor"
        aria-label={`Page ${page} editor, ${toolLabel} tool${selected ? ", an item is selected" : ""}`}
        aria-describedby="editor-canvas-help"
        tabIndex={0}
        className="relative mx-auto select-none overflow-hidden rounded-lg border border-gray-300 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-mantis-500 dark:border-[#333]"
        style={{ width: pw, height: ph }}
      >
        <PageImage source={source} page={page} width={PREVIEW_WIDTH} alt={`Page ${page}`} className="h-full" />
        <svg
          ref={svgRef}
          data-testid="editor-overlay"
          className="absolute inset-0 touch-none"
          width={pw}
          height={ph}
          viewBox={`0 0 ${pw} ${ph}`}
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => cancelGesture()}
          onDoubleClick={(e) => {
            if (tool !== "select") return;
            const hit = hitTestItems(items, page, toVisible(pointerPx(e)), Math.max(HIT_SLOP, 6 / scale));
            if (hit?.kind === "text") props.onEditText(hit.id);
          }}
        >
          {pageItems.map(renderItem)}
          {renderDraft()}
          {renderSelection()}
        </svg>
        {editing && editing.kind === "text" && (
          <TextEditOverlay
            key={editing.id}
            item={editing}
            previewSize={preview}
            pageSize={pageSize}
            onCommit={(text, byKey) => {
              props.onCommitText(editing.id, text);
              if (byKey) rootRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>
      <p id="editor-canvas-help" className="mt-2 text-center text-xs text-gray-500 dark:text-[#777]">
        Drag to create, click an item to select it. Arrow keys move the selection by 1 pt (Shift: 10 pt), Delete removes it,
        Ctrl+Z undoes. Shift while resizing keeps the proportions.
      </p>
    </div>
  );
}
