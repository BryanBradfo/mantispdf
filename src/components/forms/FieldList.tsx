import { useId } from "react";
import { useFormFonts } from "./formFontsContext";
import { notoNotice } from "../../lib/forms/unicode";
import { missingMessage } from "../../lib/editor/unicodeText";
import { Link, Trans, useT } from "../../i18n";
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
import { Info } from "lucide-react";
import { checkClass, focusRing, linkClass, noticeClass } from "../../styles/ui";

const fieldClass = `mt-1 w-full rounded-none border border-line-strong bg-paper px-2 py-1.5 text-sm text-ink focus-visible:border-ink disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-2 ${focusRing}`;
/** An invalid value (aria-invalid): danger border. */
const invalidClass = "!border-danger";

/** First page a field is drawn on, or null. */
export const pageOf = (f: FormField): number | null => f.widgets.find(isDrawn)?.page ?? null;

/** Fields listed for the user: shown on a page, not push buttons. */
export const listedFields = (fields: readonly FormField[]): FormField[] =>
  fields.filter((f) => f.kind.kind !== "button" && pageOf(f) !== null);

interface PanelControlProps {
  field: FormField;
  value: FormValue;
  onChange: (v: FormValue) => void;
  labelId: string;
  /** Id of the message saying why the value is invalid, or null when it is valid. */
  errorId: string | null;
}

function PanelControl({ field, value, onChange, labelId, errorId }: PanelControlProps) {
  const t = useT("fillForm");
  // Text inputs only: the values that can be invalid are typed ones.
  const invalid = errorId ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  const textClass = errorId ? `${fieldClass} ${invalidClass}` : fieldClass;
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
          {...invalid}
          className={textClass}
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
          {...invalid}
          className={`${textClass} ${kind.comb ? "font-mono tracking-widest" : ""}`}
        />
      );
    case "checkbox": {
      const states = field.onStates;
      return (
        <div className="mt-1 flex flex-wrap gap-3" role="group" aria-labelledby={labelId}>
          {states.map((state) => (
            <label key={state} className="flex items-center gap-1.5 text-sm text-ink">
              <input
                type="checkbox"
                aria-label={states.length === 1 ? label : t("labelOption", { label, option: state })}
                aria-required={required}
                disabled={disabled}
                checked={namesOf(value).includes(state)}
                onChange={() => onChange(toggled(value, state))}
                className={checkClass}
              />
              {states.length === 1 ? t("checked") : state}
            </label>
          ))}
        </div>
      );
    }
    case "radio":
      return (
        <div className="mt-1 flex flex-wrap gap-3" role="radiogroup" aria-labelledby={labelId} aria-required={required}>
          {field.onStates.map((state) => (
            <label key={state} className="flex items-center gap-1.5 text-sm text-ink">
              <input
                type="radio"
                aria-label={t("labelOption", { label, option: radioLabel(field, state, t) })}
                name={`list-field-${field.id}`}
                disabled={disabled}
                checked={namesOf(value).includes(state)}
                onChange={() => onChange({ kind: "names", names: [state] })}
                className={checkClass}
              />
              {radioLabel(field, state, t)}
            </label>
          ))}
          {!disabled && namesOf(value).length > 0 && (
            <button type="button" onClick={() => onChange(NO_VALUE)} className={`text-xs text-ink-2 underline underline-offset-4 hover:text-ink ${focusRing}`}>
              {t("clear")}
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
            {...invalid}
            className={textClass}
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
          <option value="">{t("none")}</option>
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
        <p className="mt-1 text-sm text-ink-2">
          {/* A new tab: leaving this page would lose the values typed so far. */}
          <Trans
            ns="fillForm"
            k="signHint"
            components={{
              link: (c) => (
                <Link to="/sign" target="_blank" rel="noopener" className={linkClass}>
                  {c}
                </Link>
              ),
            }}
          />
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
  const t = useT("fillForm");
  const tc = useT("common");
  const base = useId();
  const fonts = useFormFonts();
  return (
    <ol aria-label={t("formFields")} className="space-y-3">
      {fields.map((field) => {
        const labelId = `${base}-${field.id}`;
        const errorId = `${labelId}-error`;
        const value = valueOf(state, field.id);
        const fieldPage = pageOf(field);
        // With the Noto fonts, only characters no font covers are refused.
        const bad = fonts ? fonts.uncovered(field, value) : unsupportedIn(field, value);
        const notice = notoNotice(field, value, tc);
        const tooLong = lengthWarning(field, value, t);
        const kind = field.kind;
        const over =
          (kind.kind === "combo" || (kind.kind === "text" && !kind.password)) &&
          (notice
            ? (fonts?.overflow(field.id) ?? false)
            : field.widgets.some((w) => isDrawn(w) && overflows(kind, w, shownText(field, value))));
        return (
          <li
            key={field.id}
            className={`border bg-surface p-3 ${fieldPage === page ? "border-line-strong" : "border-line"}`}
          >
            <div className="flex items-start justify-between gap-2">
              <span id={labelId} className="text-sm font-medium text-ink" title={field.name}>
                {field.label || field.name}
                {field.required && (
                  <>
                    <span className="ml-0.5 text-ink-2" aria-hidden="true">
                      *
                    </span>
                    <span className="sr-only"> {t("required")}</span>
                  </>
                )}
                {isDirty(state, field.id) && <span className="sr-only"> {t("changed")}</span>}
              </span>
              {fieldPage !== null && (
                <button
                  type="button"
                  onClick={() => onPage(fieldPage)}
                  aria-label={t("showPage", { page: fieldPage })}
                  className={`shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2 underline underline-offset-4 hover:text-ink ${focusRing}`}
                >
                  {t("pageShort", { page: fieldPage })}
                </button>
              )}
            </div>
            <p className="text-xs text-ink-2">
              {t(`kind.${field.kind.kind}`)}
              {field.readOnly && ` ${t("readOnly")}`}
            </p>
            <PanelControl field={field} value={value} onChange={(v) => onChange(field.id, v)} labelId={labelId} errorId={bad !== "" || tooLong ? errorId : null} />
            {bad !== "" && (
              <p role="alert" id={errorId} className="mt-1 text-xs text-danger">
                {fonts ? missingMessage(bad, tc) : t("unsupportedChars", { chars: bad })}
              </p>
            )}
            {notice && bad === "" && (
              <p className={`mt-2 flex gap-2 !px-3 !py-2 !text-xs ${noticeClass}`}>
                <Info aria-hidden="true" strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0" />
                <span>{notice}</span>
              </p>
            )}
            {tooLong && <p id={bad === "" ? errorId : undefined} className="mt-1 text-xs text-danger">{tooLong}</p>}
            {!tooLong && over && <p className="mt-1 text-xs text-ink">{t("overflow")}.</p>}
            {kind.kind === "text" && kind.password && (
              <p className="mt-1 text-xs text-ink-2">{t("passwordNote")}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
