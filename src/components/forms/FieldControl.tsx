import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { unsupportedChars } from "../../lib/editor/afm";
import { cssFont } from "../editor/svgStyle";
import { PADDING, textFontSize, widgetFrame } from "../../lib/forms/layout";
import { NO_VALUE, type FormField, type FormValue, type FormWidget } from "../../lib/forms/model";

export const textOf = (v: FormValue): string => (v.kind === "text" ? v.text : "");
export const namesOf = (v: FormValue): string[] => (v.kind === "names" ? v.names : []);

/** The text a field holds that the standard PDF fonts cannot save ("" when all is fine). */
export function unsupportedIn(field: FormField, value: FormValue): string {
  const k = field.kind.kind;
  return k === "text" || k === "combo" ? unsupportedChars(textOf(value)) : "";
}

/** Checkbox widget clicked: on with its own state, or off when it was on. */
export function toggled(value: FormValue, state: string): FormValue {
  return namesOf(value).includes(state) ? NO_VALUE : { kind: "names", names: [state] };
}

const ALIGN: Record<0 | 1 | 2, CSSProperties["textAlign"]> = { 0: "left", 1: "center", 2: "right" };

interface OverlayProps {
  field: FormField;
  widget: FormWidget;
  value: FormValue;
  onChange: (value: FormValue) => void;
  /** Preview pixels per point. */
  scale: number;
  /** The widget box in preview pixels. */
  box: { left: number; top: number; width: number; height: number };
}

// See-through: the preview is drawn without the file's field appearances (FormCanvas), so only
// the page's own printing (labels, comb ticks) is under a control, and it stays readable.
const frameClass = "border border-sky-400/80 bg-sky-100/40";
const controlClass = `h-full w-full rounded-none ${frameClass} text-gray-900 outline-none focus:border-mantis-600 focus:ring-2 focus:ring-mantis-500 disabled:cursor-not-allowed disabled:border-gray-300 disabled:bg-gray-100/40 disabled:text-gray-700`;

/**
 * The HTML control drawn over one widget of the page: sized to the widget, its content turned
 * with the widget (/MK /R and page rotation), the text in the field's font size.
 */
export default function FieldControl({ field, widget, value, onChange, scale, box }: OverlayProps) {
  const { width, height } = widgetFrame(widget);
  const fw = width * scale;
  const fh = height * scale;
  // The content frame is centred on the box and turned: the PDF turns counterclockwise.
  const frame: CSSProperties = {
    position: "absolute",
    left: box.left + box.width / 2 - fw / 2,
    top: box.top + box.height / 2 - fh / 2,
    width: fw,
    height: fh,
    transform: widget.rotation ? `rotate(${-widget.rotation}deg)` : undefined,
  };
  const disabled = field.readOnly;
  const label = field.label || field.name;
  const bad = unsupportedIn(field, value) !== "";
  const invalid = bad ? " !border-red-600 !ring-2 !ring-red-500" : "";
  const kind = field.kind;

  // pdf.js still paints read-only text and choice fields into the preview (their appearance has
  // its own canvas even without widgets), and the value cannot change: frame it, draw nothing.
  if (disabled && (kind.kind === "text" || kind.kind === "combo" || kind.kind === "list")) {
    const shown = kind.kind === "list" ? namesOf(value).join(", ") : textOf(value);
    return (
      <div
        style={frame}
        role="note"
        aria-label={`${label} (read-only)${shown ? `: ${shown}` : ""}`}
        title={`${label} (read-only)`}
        className="border border-dashed border-gray-400/80"
      />
    );
  }

  switch (kind.kind) {
    case "text": {
      const text = textOf(value);
      const fontPx = textFontSize(kind, widget, text) * scale;
      const { family, weight } = cssFont(widget.font);
      const style: CSSProperties = {
        fontSize: fontPx,
        lineHeight: kind.multiline ? 1.15 : 1,
        textAlign: ALIGN[widget.align],
        padding: `0 ${PADDING * scale}px`,
        fontFamily: family,
        fontWeight: weight,
      };
      if (kind.comb && kind.maxLen !== null && kind.maxLen > 0) {
        // One character per cell: a monospace font spaced to the cell width.
        const cell = fw / kind.maxLen;
        const glyph = 0.6 * fontPx;
        style.fontFamily = '"Courier New", Courier, monospace';
        style.letterSpacing = cell - glyph;
        style.paddingLeft = Math.max(0, (cell - glyph) / 2);
        style.paddingRight = 0;
        style.textAlign = "left";
      }
      const common = {
        "aria-label": label,
        "aria-required": field.required || undefined,
        "aria-invalid": bad || undefined,
        disabled,
        value: text,
        maxLength: kind.maxLen ?? undefined,
        className: controlClass + invalid,
        style,
        title: bad ? `${label}: characters the PDF fonts cannot save` : label,
      };
      return (
        <div style={frame}>
          {kind.multiline ? (
            <textarea {...common} onChange={(e) => onChange({ kind: "text", text: e.target.value })} className={`${common.className} resize-none`} style={{ ...style, paddingTop: PADDING * scale }} />
          ) : (
            <input
              {...common}
              type={kind.password ? "password" : "text"}
              autoComplete="off"
              onChange={(e) => onChange({ kind: "text", text: e.target.value })}
            />
          )}
        </div>
      );
    }
    case "checkbox":
    case "radio": {
      const state = widget.onState;
      if (state === null) return null;
      const checked = namesOf(value).includes(state);
      return (
        <div style={frame} className={`flex items-center justify-center ${frameClass}`}>
          <input
            type={kind.kind}
            name={kind.kind === "radio" ? `field-${field.id}` : undefined}
            aria-label={kind.kind === "radio" ? `${label}: ${state}` : label}
            aria-required={field.required || undefined}
            checked={checked}
            disabled={disabled}
            onChange={() => onChange(kind.kind === "radio" ? { kind: "names", names: [state] } : toggled(value, state))}
            className="m-0 h-[80%] w-[80%] cursor-pointer accent-mantis-600 disabled:cursor-not-allowed"
          />
        </div>
      );
    }
    case "combo": {
      const text = textOf(value);
      const fontPx = textFontSize({ kind: "text", multiline: false, comb: false, maxLen: null, password: false }, widget, text) * scale;
      const { family, weight } = cssFont(widget.font);
      const style: CSSProperties = {
        fontSize: fontPx,
        fontFamily: family,
        fontWeight: weight,
        padding: `0 ${PADDING * scale}px`,
        textAlign: ALIGN[widget.align],
      };
      if (kind.editable) {
        const listId = `field-${field.id}-options`;
        return (
          <div style={frame}>
            <input
              list={listId}
              aria-label={label}
              aria-required={field.required || undefined}
              aria-invalid={bad || undefined}
              disabled={disabled}
              value={text}
              onChange={(e) => onChange({ kind: "text", text: e.target.value })}
              className={controlClass + invalid}
              style={style}
            />
            <datalist id={listId}>
              {field.options.map((o) => (
                <option key={o.exportValue} value={o.exportValue}>{o.display}</option>
              ))}
            </datalist>
          </div>
        );
      }
      return (
        <div style={frame}>
          <select
            aria-label={label}
            aria-required={field.required || undefined}
            disabled={disabled}
            value={text}
            onChange={(e) => onChange(e.target.value === "" ? NO_VALUE : { kind: "text", text: e.target.value })}
            className={controlClass}
            style={{ ...style, padding: 0 }}
          >
            <option value="">{" "}</option>
            {field.options.map((o) => (
              <option key={o.exportValue} value={o.exportValue}>{o.display}</option>
            ))}
          </select>
        </div>
      );
    }
    case "list": {
      const names = namesOf(value);
      const fontPx = (widget.fontSize > 0 ? widget.fontSize : 12) * scale;
      return (
        <div style={frame}>
          <select
            multiple={kind.multi}
            size={Math.max(2, field.options.length)}
            aria-label={label}
            aria-required={field.required || undefined}
            disabled={disabled}
            value={kind.multi ? names : (names[0] ?? "")}
            onChange={(e) => {
              const picked = Array.from(e.target.selectedOptions, (o) => o.value);
              onChange(picked.length === 0 ? NO_VALUE : { kind: "names", names: picked });
            }}
            className={controlClass}
            style={{ fontSize: fontPx, fontFamily: cssFont(widget.font).family, padding: 0 }}
          >
            {field.options.map((o) => (
              <option key={o.exportValue} value={o.exportValue}>{o.display}</option>
            ))}
          </select>
        </div>
      );
    }
    case "signature":
      return (
        <div style={frame} className="flex items-center justify-center border border-dashed border-sky-500 bg-sky-50/60 text-center">
          <Link to="/sign" className="px-1 text-[11px] font-medium leading-tight text-sky-800 underline">
            Sign with Sign PDF
          </Link>
        </div>
      );
    case "button":
      return null;
  }
}
