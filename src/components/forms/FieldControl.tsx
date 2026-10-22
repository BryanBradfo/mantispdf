import type { CSSProperties } from "react";
import { Link } from "../../i18n";
import { cssFont } from "../editor/svgStyle";
import { PADDING, overflows, textFontSize, widgetFrame } from "../../lib/forms/layout";
import { NO_VALUE, type FormField, type FormValue, type FormWidget } from "../../lib/forms/model";
import {
  choiceOptions,
  comboValueFor,
  isEmpty,
  lengthLimit,
  lengthWarning,
  namesOf,
  radioLabel,
  selection,
  shownText,
  textOf,
  toggled,
  unsupportedIn,
} from "../../lib/forms/values";

/** Tooltip of a value the engine's appearance would cut off. */
export const OVERFLOW_NOTE = "Too long for this field: the PDF will cut it off";

/** Courier New's advance width, in em. */
const MONO_ADVANCE = 0.6;
/** Border of a control, in CSS pixels (Tailwind `border`). */
const BORDER_PX = 1;

const ALIGN: Record<0 | 1 | 2, CSSProperties["textAlign"]> = { 0: "left", 1: "center", 2: "right" };

interface OverlayProps {
  field: FormField;
  widget: FormWidget;
  /** Index of `widget` in `field.widgets` (keeps ids unique when a field is shown twice). */
  index: number;
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
export default function FieldControl({ field, widget, index, value, onChange, scale, box }: OverlayProps) {
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
  const kind = field.kind;
  const bad = unsupportedIn(field, value) !== "";
  const tooLong = lengthWarning(field, value);
  // A password's text is not drawn in the file (Acrobat behaviour), so it cannot overflow.
  const over =
    (kind.kind === "combo" || (kind.kind === "text" && !kind.password)) && overflows(kind, widget, shownText(field, value));
  const missing = field.required && !disabled && isEmpty(value);
  // Most serious first: unsavable characters, then a value that is too long or cut off, then an
  // empty required field.
  const invalid = bad
    ? " !border-red-600 !ring-2 !ring-red-500"
    : tooLong || over
      ? " !border-amber-500 !ring-2 !ring-amber-400"
      : missing
        ? " !border-red-500"
        : "";
  const title = bad
    ? `${label}: characters the PDF fonts cannot save`
    : tooLong
      ? `${label}: ${tooLong}`
      : over
        ? `${label}: ${OVERFLOW_NOTE}`
        : missing
          ? `${label} (required)`
          : label;
  // Lets the page move focus to a field (required-field check, Tab across pages).
  const focusTarget = { "data-field-control": field.id };

  // pdf.js still paints read-only text fields into the widget-less preview (their appearance
  // gets its own canvas), and the value cannot change: frame it, draw nothing over it. Read-only
  // combo and list boxes are not painted, so they keep a disabled control showing the value.
  if (disabled && kind.kind === "text") {
    const shown = textOf(value);
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
      let combClip = false;
      if (kind.comb && kind.maxLen !== null && kind.maxLen > 0) {
        // One character per cell, the cells of the PDF: maxLen equal cells inside the border, a
        // monospace font spaced so each character advances by a cell, centred in it (half a gap
        // of padding first). The last character still carries its full gap, half a gap more
        // than the box holds: the input is that much wider than its frame, which clips it and
        // draws the border, so a full field neither scrolls nor drifts.
        const glyph = MONO_ADVANCE * fontPx;
        const cell = (fw - 2 * BORDER_PX) / kind.maxLen;
        const gap = cell - glyph;
        style.fontFamily = '"Courier New", Courier, monospace';
        style.fontWeight = 400;
        style.letterSpacing = gap;
        // Longhands only: mixing them with the `padding` shorthand loses the left padding.
        delete style.padding;
        style.paddingTop = 0;
        style.paddingBottom = 0;
        style.paddingRight = 0;
        style.paddingLeft = gap / 2;
        style.textAlign = "left";
        style.width = `calc(100% + ${Math.max(0, gap / 2) + 2}px)`;
        style.maxWidth = "none";
        combClip = true;
      }
      const common = {
        ...focusTarget,
        "aria-label": label,
        "aria-required": field.required || undefined,
        "aria-invalid": bad || tooLong !== null || undefined,
        disabled,
        value: text,
        maxLength: lengthLimit(field),
        className: controlClass + invalid,
        style,
        title,
      };
      if (combClip) {
        return (
          <div
            style={frame}
            // `clip`, not `hidden`: a clipping box that is not a scroll container, so revealing
            // the caret cannot shift the cells sideways.
            className={`overflow-clip ${frameClass} focus-within:border-mantis-600 focus-within:ring-2 focus-within:ring-mantis-500${invalid}`}
          >
            <input
              {...common}
              className="h-full border-0 bg-transparent p-0 text-gray-900 outline-none focus:ring-0 disabled:cursor-not-allowed"
              type={kind.password ? "password" : "text"}
              autoComplete="off"
              onChange={(e) => onChange({ kind: "text", text: e.target.value })}
            />
          </div>
        );
      }
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
      const radio = kind.kind === "radio";
      return (
        <div style={frame} className={`flex items-center justify-center ${frameClass}${missing ? " !border-red-500" : ""}`} title={title}>
          {/* No shared `name`: a radio is checked by the value alone, so widgets sharing one
              state (RadiosInUnison) all show checked. */}
          <input
            {...focusTarget}
            type={kind.kind}
            aria-label={radio ? `${label}: ${radioLabel(field, state)}` : label}
            aria-required={field.required || undefined}
            checked={checked}
            disabled={disabled}
            onChange={() => onChange(radio ? { kind: "names", names: [state] } : toggled(value, state))}
            // A checked radio clicked again clears the choice, unless the field is required.
            onClick={() => {
              if (radio && checked && !field.required) onChange(NO_VALUE);
            }}
            className="m-0 h-[80%] w-[80%] cursor-pointer accent-mantis-600 disabled:cursor-not-allowed"
          />
        </div>
      );
    }
    case "combo": {
      const text = shownText(field, value);
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
        const listId = `field-${field.id}-${index}-options`;
        return (
          <div style={frame}>
            {/* Shows and suggests display texts; a picked display text stores its export value. */}
            <input
              {...focusTarget}
              list={listId}
              aria-label={label}
              aria-required={field.required || undefined}
              aria-invalid={bad || tooLong !== null || undefined}
              title={title}
              disabled={disabled}
              value={text}
              maxLength={lengthLimit(field)}
              onChange={(e) => onChange(comboValueFor(field, e.target.value))}
              className={controlClass + invalid}
              style={style}
            />
            <datalist id={listId}>
              {field.options.map((o, i) => (
                <option key={i} value={o.display} />
              ))}
            </datalist>
          </div>
        );
      }
      return (
        <div style={frame}>
          <select
            {...focusTarget}
            aria-label={label}
            aria-required={field.required || undefined}
            title={title}
            disabled={disabled}
            value={textOf(value)}
            onChange={(e) => onChange(e.target.value === "" ? NO_VALUE : { kind: "text", text: e.target.value })}
            className={controlClass + invalid}
            style={{ ...style, padding: 0 }}
          >
            <option value="">{"\u00a0"}</option>
            {choiceOptions(field, value).map((o, i) => (
              <option key={i} value={o.exportValue}>{o.display}</option>
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
            {...focusTarget}
            multiple={kind.multi}
            size={Math.max(2, field.options.length)}
            aria-label={label}
            aria-required={field.required || undefined}
            title={title}
            disabled={disabled}
            value={kind.multi ? names : (names[0] ?? "")}
            onChange={(e) => onChange(selection(Array.from(e.target.selectedOptions, (o) => o.value)))}
            className={controlClass + invalid}
            style={{ fontSize: fontPx, fontFamily: cssFont(widget.font).family, padding: 0 }}
          >
            {choiceOptions(field, value).map((o, i) => (
              <option key={i} value={o.exportValue}>{o.display}</option>
            ))}
          </select>
        </div>
      );
    }
    case "signature":
      return (
        <div style={frame} className="flex items-center justify-center border border-dashed border-sky-500 bg-sky-50/60 text-center">
          {/* A new tab: leaving this page would lose the values typed so far. */}
          <Link
            {...focusTarget}
            to="/sign"
            target="_blank"
            rel="noopener"
            title="Download the filled form, then sign it with Sign PDF."
            className="px-1 text-[11px] font-medium leading-tight text-sky-800 underline"
          >
            Sign PDF (new tab)
          </Link>
        </div>
      );
    case "button":
      return null;
  }
}
