import { useId } from "react";
import { useFormFonts } from "./formFontsContext";
import { notoNotice } from "../../lib/forms/unicode";
import { missingMessage } from "../../lib/editor/unicodeText";
import { Link } from "react-router-dom";
import { unsupportedMessage } from "../../lib/editor/afm";
import { NO_VALUE, isDirty, isDrawn, valueOf, type FormField, type FormState, type FormValue } from "../../lib/forms/model";
import { overflows } from "../../lib/forms/layout";
import {
  choiceOptions,
  comboValueFor,
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
import { OVERFLOW_NOTE } from "./FieldControl";

const KIND_LABEL: Record<FormField["kind"]["kind"], string> = {
  text: "Text",
  checkbox: "Checkbox",
  radio: "Choice",
  combo: "Drop-down",
  list: "List",
  signature: "Signature",
  button: "Button",
};

const fieldClass =
  "mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-mantis-500 focus:outline-none focus:ring-1 focus:ring-mantis-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-[#333] dark:bg-[#111] dark:text-[#ddd] dark:disabled:bg-[#1a1a1a]";

/** First page a field is drawn on, or null. */
export const pageOf = (f: FormField): number | null => f.widgets.find(isDrawn)?.page ?? null;

/** Fields listed for the user: shown on a page, not push buttons. */
export const listedFields = (fields: readonly FormField[]): FormField[] =>
  fields.filter((f) => f.kind.kind !== "button" && pageOf(f) !== null);

function PanelControl({ field, value, onChange, labelId }: { field: FormField; value: FormValue; onChange: (v: FormValue) => void; labelId: string }) {
  const disabled = field.readOnly;
  const kind = field.kind;
  const label = field.label || field.name;
  const required = field.required || undefined;
  switch (kind.kind) {
    case "text":
      return kind.multiline ? (
        <textarea
          aria-labelledby={labelId}
          aria-required={required}
          disabled={disabled}
          rows={3}
          maxLength={lengthLimit(field)}
          value={textOf(value)}
          onChange={(e) => onChange({ kind: "text", text: e.target.value })}
          className={fieldClass}
        />
      ) : (
        <input
          aria-labelledby={labelId}
          aria-required={required}
          type={kind.password ? "password" : "text"}
          autoComplete="off"
          disabled={disabled}
          maxLength={lengthLimit(field)}
          value={textOf(value)}
          onChange={(e) => onChange({ kind: "text", text: e.target.value })}
          className={`${fieldClass} ${kind.comb ? "font-mono tracking-widest" : ""}`}
        />
      );
    case "checkbox": {
      const states = field.onStates;
      return (
        <div className="mt-1 flex flex-wrap gap-3" role="group" aria-labelledby={labelId}>
          {states.map((state) => (
            <label key={state} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-[#bbb]">
              <input
                type="checkbox"
                aria-label={states.length === 1 ? label : `${label}: ${state}`}
                aria-required={required}
                disabled={disabled}
                checked={namesOf(value).includes(state)}
                onChange={() => onChange(toggled(value, state))}
                className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
              />
              {states.length === 1 ? "Checked" : state}
            </label>
          ))}
        </div>
      );
    }
    case "radio":
      return (
        <div className="mt-1 flex flex-wrap gap-3" role="radiogroup" aria-labelledby={labelId} aria-required={required}>
          {field.onStates.map((state) => (
            <label key={state} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-[#bbb]">
              <input
                type="radio"
                aria-label={`${label}: ${radioLabel(field, state)}`}
                name={`list-field-${field.id}`}
                disabled={disabled}
                checked={namesOf(value).includes(state)}
                onChange={() => onChange({ kind: "names", names: [state] })}
                className="h-4 w-4 border-gray-300 text-mantis-600 focus:ring-mantis-500"
              />
              {radioLabel(field, state)}
            </label>
          ))}
          {!disabled && namesOf(value).length > 0 && (
            <button type="button" onClick={() => onChange(NO_VALUE)} className="text-xs text-gray-500 underline dark:text-[#888]">
              Clear
            </button>
          )}
        </div>
      );
    case "combo":
      return kind.editable ? (
        <>
          <input
            aria-labelledby={labelId}
            aria-required={required}
            list={`list-field-${field.id}-options`}
            disabled={disabled}
            maxLength={lengthLimit(field)}
            value={shownText(field, value)}
            onChange={(e) => onChange(comboValueFor(field, e.target.value))}
            className={fieldClass}
          />
          <datalist id={`list-field-${field.id}-options`}>
            {field.options.map((o, i) => (
              <option key={i} value={o.display} />
            ))}
          </datalist>
        </>
      ) : (
        <select
          aria-labelledby={labelId}
          aria-required={required}
          disabled={disabled}
          value={textOf(value)}
          onChange={(e) => onChange(e.target.value === "" ? NO_VALUE : { kind: "text", text: e.target.value })}
          className={fieldClass}
        >
          <option value="">(none)</option>
          {choiceOptions(field, value).map((o, i) => (
            <option key={i} value={o.exportValue}>{o.display}</option>
          ))}
        </select>
      );
    case "list":
      return (
        <select
          aria-labelledby={labelId}
          aria-required={required}
          multiple={kind.multi}
          size={Math.min(6, Math.max(2, field.options.length))}
          disabled={disabled}
          value={kind.multi ? namesOf(value) : (namesOf(value)[0] ?? "")}
          onChange={(e) => onChange(selection(Array.from(e.target.selectedOptions, (o) => o.value)))}
          className={fieldClass}
        >
          {choiceOptions(field, value).map((o, i) => (
            <option key={i} value={o.exportValue}>{o.display}</option>
          ))}
        </select>
      );
    case "signature":
      return (
        <p className="mt-1 text-sm text-gray-600 dark:text-[#999]">
          Download the filled form, then sign it with{" "}
          {/* A new tab: leaving this page would lose the values typed so far. */}
          <Link to="/sign" target="_blank" rel="noopener" className="font-medium text-mantis-700 underline dark:text-mantis-400">
            Sign PDF
          </Link>
          .
        </p>
      );
    case "button":
      return null;
  }
}

interface Props {
  /** Fields in tab order (already filtered with `listedFields`). */
  fields: readonly FormField[];
  state: FormState;
  onChange: (id: number, value: FormValue) => void;
  /** Page shown in the preview, and how to show another one. */
  page: number;
  onPage: (page: number) => void;
}

/** Every field in tab order, editable here as on the page. */
export default function FieldList({ fields, state, onChange, page, onPage }: Props) {
  const base = useId();
  const fonts = useFormFonts();
  return (
    <ol aria-label="Form fields" className="space-y-3">
      {fields.map((field) => {
        const labelId = `${base}-${field.id}`;
        const value = valueOf(state, field.id);
        const fieldPage = pageOf(field);
        // With the Noto fonts, only characters no font covers are refused.
        const bad = fonts ? fonts.uncovered(field, value) : unsupportedIn(field, value);
        const notice = notoNotice(field, value);
        const tooLong = lengthWarning(field, value);
        const kind = field.kind;
        const over =
          (kind.kind === "combo" || (kind.kind === "text" && !kind.password)) &&
          (notice
            ? (fonts?.overflow(field.id) ?? false)
            : field.widgets.some((w) => isDrawn(w) && overflows(kind, w, shownText(field, value))));
        return (
          <li
            key={field.id}
            className={`rounded-lg border p-3 ${
              fieldPage === page ? "border-gray-300 dark:border-[#3a3a3a]" : "border-gray-200 dark:border-[#262626]"
            } bg-white dark:bg-[#111]`}
          >
            <div className="flex items-start justify-between gap-2">
              <span id={labelId} className="text-sm font-medium text-gray-900 dark:text-[#ddd]" title={field.name}>
                {field.label || field.name}
                {field.required && (
                  <>
                    <span className="ml-0.5 text-red-600" aria-hidden="true">
                      *
                    </span>
                    <span className="sr-only"> (required)</span>
                  </>
                )}
                {isDirty(state, field.id) && <span className="sr-only"> (changed)</span>}
              </span>
              {fieldPage !== null && (
                <button
                  type="button"
                  onClick={() => onPage(fieldPage)}
                  aria-label={`Show page ${fieldPage}`}
                  className="shrink-0 text-xs text-gray-500 underline hover:text-gray-800 dark:text-[#888]"
                >
                  p. {fieldPage}
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-[#777]">
              {KIND_LABEL[field.kind.kind]}
              {field.readOnly && " (read-only)"}
            </p>
            <PanelControl field={field} value={value} onChange={(v) => onChange(field.id, v)} labelId={labelId} />
            {bad !== "" && (
              <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                {fonts ? missingMessage(bad) : unsupportedMessage(bad)}
              </p>
            )}
            {notice && bad === "" && <p className="mt-1 text-xs text-gray-600 dark:text-[#999]">{notice}</p>}
            {tooLong && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{tooLong}</p>}
            {!tooLong && over && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{OVERFLOW_NOTE}.</p>}
            {kind.kind === "text" && kind.password && (
              <p className="mt-1 text-xs text-gray-500 dark:text-[#888]">Password fields are not saved in the file, as in Acrobat.</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
