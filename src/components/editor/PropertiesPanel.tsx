import { useEffect, useId, useState, type ReactNode } from "react";
import { TextAlignCenter, TextAlignEnd, TextAlignStart, ArrowDown, ArrowUp, Copy, RotateCw, Trash2, type LucideIcon } from "lucide-react";
import {
  LIMITS,
  clampWidth,
  type Align,
  type Item,
  type ItemPatch,
  type Paint,
  type Rgb,
  type EditFont,
  type StrokedKind,
} from "../../lib/editor/model";
import { fitTextRect } from "../../lib/editor/textFit";
import { resolveFont, startsRightToLeft } from "../../lib/editor/unicodeText";
import { hexToRgb, rgbToHex } from "./svgStyle";

const FONTS: { value: EditFont; label: string }[] = [
  { value: "Helvetica", label: "Helvetica" },
  { value: "Helvetica-Bold", label: "Helvetica Bold" },
  { value: "Times-Roman", label: "Times Roman" },
  { value: "Courier", label: "Courier" },
  { value: "Noto Sans", label: "Noto Sans" },
  { value: "Noto Serif", label: "Noto Serif" },
  { value: "Noto Sans Mono", label: "Noto Sans Mono" },
];

const KIND_LABEL: Record<Item["kind"], string> = {
  text: "Text box",
  image: "Image",
  rect: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  highlight: "Highlight",
  freehand: "Drawing",
  whiteout: "Whiteout",
};

const labelClass = "block text-xs font-medium text-gray-700 dark:text-[#aaa]";
const fieldClass =
  "mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-mantis-500 focus:outline-none focus:ring-1 focus:ring-mantis-500 dark:border-[#333] dark:bg-[#111] dark:text-[#ddd]";
const smallButton =
  "flex items-center justify-center gap-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-mantis-500 disabled:opacity-40 dark:border-[#333] dark:text-[#bbb] dark:hover:bg-[#1a1a1a]";

interface Props {
  item: Item;
  onChange: (patch: ItemPatch) => void;
  /** Continuous inputs (colour pickers, sliders) group their changes into one undo step. */
  onBeginGesture: () => void;
  onEndGesture: () => void;
  onEditText: () => void;
  onForward: () => void;
  onBackward: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

/** Number input edited as text, applied (clamped) on blur or Enter. */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  clamp,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  clamp: (v: number) => number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const apply = () => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    const next = clamp(Number.isFinite(parsed) ? parsed : value);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <label className={labelClass}>
      {label}
      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
        className={fieldClass}
      />
    </label>
  );
}

function ColorField({
  label,
  color,
  onColor,
  onBeginGesture,
  onEndGesture,
}: {
  label: string;
  color: Rgb;
  onColor: (c: Rgb) => void;
  onBeginGesture: () => void;
  onEndGesture: () => void;
}) {
  return (
    <label className={labelClass}>
      {label}
      <input
        type="color"
        value={rgbToHex(color)}
        onFocus={onBeginGesture}
        onBlur={onEndGesture}
        onChange={(e) => onColor(hexToRgb(e.target.value))}
        className={`${fieldClass} h-9 cursor-pointer p-1`}
      />
    </label>
  );
}

function OpacityField({
  value,
  onValue,
  onBeginGesture,
  onEndGesture,
}: {
  value: number;
  onValue: (v: number) => void;
  onBeginGesture: () => void;
  onEndGesture: () => void;
}) {
  const id = useId();
  return (
    <div className={labelClass}>
      <label htmlFor={id}>Opacity ({Math.round(value * 100)}%)</label>
      <input
        id={id}
        type="range"
        min={0.1}
        max={1}
        step={0.05}
        value={value}
        onPointerDown={onBeginGesture}
        onFocus={onBeginGesture}
        onPointerUp={onEndGesture}
        onBlur={onEndGesture}
        onChange={(e) => onValue(Number(e.target.value))}
        className="mt-2 w-full accent-mantis-600"
      />
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-[#aaa]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
      />
      {label}
    </label>
  );
}

function IconButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={smallButton}>
      <Icon aria-hidden="true" className="h-4 w-4" />
      {label}
    </button>
  );
}

function WidthField({ kind, value, onCommit }: { kind: StrokedKind; value: number; onCommit: (v: number) => void }) {
  const min = kind === "line" || kind === "freehand" ? LIMITS.minStrokeWidth : LIMITS.minWidth;
  return (
    <NumberField
      label={kind === "rect" || kind === "ellipse" ? "Outline width (pt)" : "Width (pt)"}
      value={value}
      min={min}
      max={LIMITS.maxWidth}
      step={0.5}
      clamp={(v) => clampWidth(kind, v)}
      onCommit={onCommit}
    />
  );
}

const DEFAULT_PAINT: Rgb = [0, 0, 0];
const paintColor = (p: Paint, fallback: Rgb): Rgb => (p.kind === "rgb" ? p.color : fallback);

export default function PropertiesPanel(props: Props) {
  const { item, onChange, onBeginGesture, onEndGesture } = props;
  const gesture = { onBeginGesture, onEndGesture };
  let fields: ReactNode = null;

  switch (item.kind) {
    case "text": {
      // Font and size changes grow the box so no line is lost.
      const restyle = (patch: { font?: EditFont; size?: number; lineHeight?: number }) => {
        const font = patch.font ?? item.font;
        const size = patch.size ?? item.size;
        const lineHeight = patch.lineHeight ?? item.lineHeight;
        onChange({ ...patch, rect: fitTextRect(item.rect, item.text, font, size, lineHeight) });
      };
      const resolved = resolveFont(item.font, item.text);
      const switched = resolved.kind === "noto" && resolved.switched ? resolved.family : null;
      // "auto" shows the alignment it gives: right for right-to-left text.
      const shownAlign = item.align === "auto" ? (startsRightToLeft(item.text) ? "right" : "left") : item.align;
      const aligns: { value: Align; label: string; icon: LucideIcon }[] = [
        { value: "left", label: "Align left", icon: TextAlignStart },
        { value: "center", label: "Align center", icon: TextAlignCenter },
        { value: "right", label: "Align right", icon: TextAlignEnd },
      ];
      fields = (
        <>
          <button type="button" onClick={props.onEditText} className={`${smallButton} col-span-2`}>
            Edit text (Enter)
          </button>
          <label className={`${labelClass} col-span-2`}>
            Font
            <select value={item.font} onChange={(e) => restyle({ font: e.target.value as EditFont })} className={fieldClass}>
              {FONTS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </label>
          {switched && (
            <p className="col-span-2 text-xs text-gray-600 dark:text-[#999]" data-testid="font-switch-notice">
              Uses {switched} for these characters
            </p>
          )}
          <NumberField
            label="Size (pt)"
            value={item.size}
            min={LIMITS.minFontSize}
            max={LIMITS.maxFontSize}
            step={1}
            clamp={(v) => Math.min(LIMITS.maxFontSize, Math.max(LIMITS.minFontSize, v))}
            onCommit={(size) => restyle({ size })}
          />
          <NumberField
            label="Line height"
            value={item.lineHeight}
            min={LIMITS.minLineHeight}
            max={LIMITS.maxLineHeight}
            step={0.1}
            clamp={(v) => Math.min(LIMITS.maxLineHeight, Math.max(LIMITS.minLineHeight, v))}
            onCommit={(lineHeight) => restyle({ lineHeight })}
          />
          <ColorField label="Colour" color={item.color} onColor={(color) => onChange({ color })} {...gesture} />
          <div className="col-span-2 flex gap-1" role="group" aria-label="Alignment">
            {aligns.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                aria-label={label}
                aria-pressed={shownAlign === value}
                title={label}
                onClick={() => onChange({ align: value })}
                className={`${smallButton} flex-1 ${shownAlign === value ? "border-mantis-600 bg-mantis-50 dark:bg-[#0f1a0f]" : ""}`}
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
              </button>
            ))}
          </div>
          <div className="col-span-2">
            <OpacityField value={item.opacity} onValue={(opacity) => onChange({ opacity })} {...gesture} />
          </div>
        </>
      );
      break;
    }
    case "image": {
      const rotate = () => {
        // A quarter turn swaps the box sides around its centre so the image keeps its aspect.
        const [x, y, w, h] = item.rect;
        const rotation = ((item.rotation + 90) % 360) as typeof item.rotation;
        onChange({ rotation, rect: [x + (w - h) / 2, y + (h - w) / 2, h, w] });
      };
      fields = (
        <>
          <div className="col-span-2">
            <IconButton icon={RotateCw} label="Rotate 90°" onClick={rotate} />
          </div>
          <div className="col-span-2">
            <OpacityField value={item.opacity} onValue={(opacity) => onChange({ opacity })} {...gesture} />
          </div>
        </>
      );
      break;
    }
    case "rect":
    case "ellipse": {
      const strokeColor = paintColor(item.stroke, DEFAULT_PAINT);
      const fillColor = paintColor(item.fill, [1, 1, 1]);
      fields = (
        <>
          <div className="col-span-2">
            <Toggle
              label="Outline"
              checked={item.stroke.kind === "rgb"}
              onChange={(on) =>
                onChange({
                  stroke: on ? { kind: "rgb", color: strokeColor } : { kind: "none" },
                  width: on && item.width === 0 ? 2 : item.width,
                })
              }
            />
          </div>
          {item.stroke.kind === "rgb" && (
            <>
              <ColorField label="Outline colour" color={strokeColor} onColor={(color) => onChange({ stroke: { kind: "rgb", color } })} {...gesture} />
              <WidthField kind={item.kind} value={item.width} onCommit={(width) => onChange({ width })} />
            </>
          )}
          <div className="col-span-2">
            <Toggle
              label="Fill"
              checked={item.fill.kind === "rgb"}
              onChange={(on) => onChange({ fill: on ? { kind: "rgb", color: fillColor } : { kind: "none" } })}
            />
          </div>
          {item.fill.kind === "rgb" && (
            <ColorField label="Fill colour" color={fillColor} onColor={(color) => onChange({ fill: { kind: "rgb", color } })} {...gesture} />
          )}
          <div className="col-span-2">
            <OpacityField value={item.opacity} onValue={(opacity) => onChange({ opacity })} {...gesture} />
          </div>
        </>
      );
      break;
    }
    case "line":
      fields = (
        <>
          <ColorField label="Colour" color={item.color} onColor={(color) => onChange({ color })} {...gesture} />
          <WidthField kind="line" value={item.width} onCommit={(width) => onChange({ width })} />
          <Toggle label="Arrow at start" checked={item.arrowStart} onChange={(arrowStart) => onChange({ arrowStart })} />
          <Toggle label="Arrow at end" checked={item.arrowEnd} onChange={(arrowEnd) => onChange({ arrowEnd })} />
          <div className="col-span-2">
            <OpacityField value={item.opacity} onValue={(opacity) => onChange({ opacity })} {...gesture} />
          </div>
        </>
      );
      break;
    case "freehand":
      fields = (
        <>
          <ColorField label="Colour" color={item.color} onColor={(color) => onChange({ color })} {...gesture} />
          <WidthField kind="freehand" value={item.width} onCommit={(width) => onChange({ width })} />
          <div className="col-span-2">
            <OpacityField value={item.opacity} onValue={(opacity) => onChange({ opacity })} {...gesture} />
          </div>
        </>
      );
      break;
    case "highlight":
      fields = (
        <>
          <ColorField label="Colour" color={item.color} onColor={(color) => onChange({ color })} {...gesture} />
          <div className="col-span-2">
            <OpacityField value={item.opacity} onValue={(opacity) => onChange({ opacity })} {...gesture} />
          </div>
        </>
      );
      break;
    case "whiteout":
      fields = (
        <p className="col-span-2 text-xs text-gray-600 dark:text-[#888]">
          Covers what is under it with white.
        </p>
      );
      break;
  }

  return (
    <section aria-label={`${KIND_LABEL[item.kind]} properties`} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-[#333] dark:bg-[#111]">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-[#ddd]">{KIND_LABEL[item.kind]}</h2>
      <div className="mt-3 grid grid-cols-2 gap-3">{fields}</div>
      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-gray-200 pt-3 dark:border-[#333]">
        <IconButton icon={ArrowUp} label="Forward" onClick={props.onForward} />
        <IconButton icon={ArrowDown} label="Backward" onClick={props.onBackward} />
        <IconButton icon={Copy} label="Duplicate" onClick={props.onDuplicate} />
        <IconButton icon={Trash2} label="Delete" onClick={props.onDelete} />
      </div>
    </section>
  );
}
