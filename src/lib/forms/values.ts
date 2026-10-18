/** Reading and changing field values for the form controls (page overlay and side list). */
import { unsupportedChars } from "../editor/afm";
import { NO_VALUE, type FormField, type FormOption, type FormValue } from "./model";

/** Engine limits the UI enforces (`MAX_VALUE_CHARS` in crates/mantis-wasm/src/forms/mod.rs). */
export const FORM_LIMITS = { valueChars: 20000 } as const;

export const textOf = (v: FormValue): string => (v.kind === "text" ? v.text : "");
export const namesOf = (v: FormValue): string[] => (v.kind === "names" ? v.names : []);

/** The text a field holds that the standard PDF fonts cannot save ("" when all is fine). */
export function unsupportedIn(field: FormField, value: FormValue): string {
  const k = field.kind.kind;
  return k === "text" || k === "combo" ? unsupportedChars(textOf(value)) : "";
}

/** A checkbox state clicked: on with that state, or off when it was on. */
export function toggled(value: FormValue, state: string): FormValue {
  return namesOf(value).includes(state) ? NO_VALUE : { kind: "names", names: [state] };
}

/** The value of a list box selection. */
export const selection = (picked: string[]): FormValue => (picked.length === 0 ? NO_VALUE : { kind: "names", names: picked });

/** Most characters a text value may have: the field's max length, else the engine's limit. */
export function lengthLimit(field: FormField): number {
  return field.kind.kind === "text" && field.kind.maxLen !== null ? field.kind.maxLen : FORM_LIMITS.valueChars;
}

/**
 * A warning for a value already longer than the field allows (it came that way in the file):
 * the field stays editable and the value is kept until the user shortens it.
 */
export function lengthWarning(field: FormField, value: FormValue): string | null {
  const limit = lengthLimit(field);
  if (Array.from(textOf(value)).length <= limit) return null;
  return `This value is longer than the field allows (${limit} characters).`;
}

/**
 * Options of a combo or list box, plus the current value(s) missing from them (a file may hold
 * one), so a select can show what the field holds.
 */
export function choiceOptions(field: FormField, value: FormValue): FormOption[] {
  const current = value.kind === "text" ? [value.text] : namesOf(value);
  const known = new Set(field.options.map((o) => o.exportValue));
  const extra: FormOption[] = [];
  for (const v of current) {
    if (v === "" || known.has(v)) continue;
    known.add(v);
    extra.push({ exportValue: v, display: v });
  }
  return extra.length === 0 ? field.options : [...field.options, ...extra];
}
