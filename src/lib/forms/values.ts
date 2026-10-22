/** Reading and changing field values for the form controls (page overlay and side list). */
import { unsupportedChars, unsupportedMessage } from "../editor/afm";
import { NO_VALUE, isDirty, valueOf, type FormField, type FormOption, type FormState, type FormValue } from "./model";

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

/** No value, an empty text or an empty selection (as the engine counts them). */
export const isEmpty = (v: FormValue): boolean =>
  v.kind === "none" || (v.kind === "text" && v.text === "") || (v.kind === "names" && v.names.length === 0);

/** What a text-like control shows: an editable combo shows its option's display text. */
export function shownText(field: FormField, value: FormValue): string {
  const t = textOf(value);
  if (field.kind.kind !== "combo") return t;
  return field.options.find((o) => o.exportValue === t)?.display ?? t;
}

/** The value of an editable combo for `typed`: the option's export value when it names one. */
export function comboValueFor(field: FormField, typed: string): FormValue {
  if (typed === "") return NO_VALUE;
  const option = field.options.find((o) => o.display === typed);
  return { kind: "text", text: option ? option.exportValue : typed };
}

/**
 * How a radio state is named for people: the /Opt display text when the file has one (by export
 * value, or by index for index-named states), "Option N" for engine-generated or index names
 * ("On", "On2", "0"...), else the state name itself.
 */
export function radioLabel(field: FormField, state: string): string {
  const byValue = field.options.find((o) => o.exportValue === state);
  if (byValue) return byValue.display;
  const position = field.onStates.indexOf(state);
  if (/^\d+$/.test(state)) {
    const option = field.options[Number(state)];
    if (option) return option.display;
    return `Option ${(position >= 0 ? position : Number(state)) + 1}`;
  }
  if (/^On\d*$/.test(state)) return `Option ${position + 1}`;
  return state;
}

/** Fields a person must fill (required, fillable here) that are still empty, in `fields` order. */
export function missingRequired(fields: readonly FormField[], state: FormState): FormField[] {
  return fields.filter(
    (f) => f.required && !f.readOnly && f.kind.kind !== "signature" && f.kind.kind !== "button" && isEmpty(valueOf(state, f.id)),
  );
}

/**
 * The first changed value the engine would refuse, as a message naming its field, or null.
 * Values left as the file has them are not checked: a non-flattened fill keeps them untouched
 * (flattening refuses them itself, and the engine's error names the field).
 */
export function blockingProblem(
  fields: readonly FormField[],
  state: FormState,
  /** Characters of a value nothing can draw (default: those the standard fonts lack). */
  uncovered: (field: FormField, value: FormValue) => string = unsupportedIn,
  message: (bad: string) => string = unsupportedMessage,
): string | null {
  for (const f of fields) {
    if (!isDirty(state, f.id)) continue;
    const value = valueOf(state, f.id);
    const name = f.label || f.name;
    const bad = uncovered(f, value);
    if (bad !== "") return `${message(bad)} (field "${name}").`;
    const long = lengthWarning(f, value);
    if (long) return `${long} (field "${name}")`;
  }
  return null;
}
