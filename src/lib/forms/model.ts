/**
 * Fill PDF form model. `FormInfo` mirrors what the Rust `list_form` returns
 * (crates/mantis-wasm/src/forms/binding.rs `form_to_js`) in camelCase. Widget
 * rectangles are in visible page space: points, origin at the bottom-left of
 * the page as displayed (CropBox, /Rotate applied), like the editor.
 */

import type { StdFont } from "../stampJob";

/** A field value, also the wire shape `fill_form` reads. */
export type FormValue = { kind: "text"; text: string } | { kind: "names"; names: string[] } | { kind: "none" };

export type FieldKind =
  | { kind: "text"; multiline: boolean; comb: boolean; maxLen: number | null; password: boolean }
  | { kind: "checkbox" }
  | { kind: "radio" }
  | { kind: "combo"; editable: boolean }
  | { kind: "list"; multi: boolean }
  | { kind: "signature" }
  | { kind: "button" };

export interface FormWidget {
  /** 1-based page number; 0 when the widget is on no page (listed, never drawn). */
  page: number;
  /** `[x0, y0, x1, y1]` in visible points (user space when `page` is 0). */
  rect: [number, number, number, number];
  /**
   * Counterclockwise rotation of the widget's content as seen on screen:
   * (/MK /R - page /Rotate) mod 360. For display only.
   */
  rotation: 0 | 90 | 180 | 270;
  /**
   * The state name that turns this button widget on, as the engine names it
   * (generated names included). The UI never invents state names.
   */
  onState: string | null;
  /** Hidden or NoView: not shown, kept unchanged. */
  hidden: boolean;
  /** The standard font the engine draws this widget's text with (from /DA). */
  font: StdFont;
  /** /DA font size; 0 means auto size. */
  fontSize: number;
  /** 0 left, 1 centre, 2 right. */
  align: 0 | 1 | 2;
}

export interface FormOption {
  exportValue: string;
  display: string;
}

export interface FormField {
  /** Index in the engine's traversal: what `fill_form` takes. */
  id: number;
  /** Full name `a.b.c`. */
  name: string;
  /** Tooltip, else partial name. */
  label: string;
  kind: FieldKind;
  readOnly: boolean;
  required: boolean;
  value: FormValue;
  options: FormOption[];
  onStates: string[];
  widgets: FormWidget[];
}

export interface FormInfo {
  xfa: "none" | "hybrid" | "pure";
  fields: FormField[];
}

/** The values being edited next to the ones the file had. */
export interface FormState {
  original: ReadonlyMap<number, FormValue>;
  values: ReadonlyMap<number, FormValue>;
}

export const NO_VALUE: FormValue = { kind: "none" };

/** A widget the page view draws a control for. */
export const isDrawn = (w: FormWidget): boolean => w.page > 0 && !w.hidden;

/** A field the user can change: not read-only, not a signature or push button. */
export const isEditable = (f: FormField): boolean =>
  !f.readOnly && f.kind.kind !== "signature" && f.kind.kind !== "button";

/** Equal values, an empty text or selection counting as no value (as the engine does). */
export function sameValue(a: FormValue, b: FormValue): boolean {
  const norm = (v: FormValue): FormValue => {
    if (v.kind === "text" && v.text === "") return NO_VALUE;
    if (v.kind === "names" && v.names.length === 0) return NO_VALUE;
    return v;
  };
  const x = norm(a);
  const y = norm(b);
  if (x.kind === "none" || y.kind === "none") return x.kind === y.kind;
  if (x.kind === "text" && y.kind === "text") return x.text === y.text;
  if (x.kind === "names" && y.kind === "names") {
    // A selection is a set: order does not matter.
    const sx = [...new Set(x.names)].sort();
    const sy = [...new Set(y.names)].sort();
    return sx.length === sy.length && sx.every((n, i) => n === sy[i]);
  }
  return false;
}

export function initialFormState(info: FormInfo): FormState {
  const original = new Map(info.fields.map((f) => [f.id, f.value] as const));
  return { original, values: original };
}

export function setValue(state: FormState, id: number, value: FormValue): FormState {
  if (!state.original.has(id)) return state;
  const values = new Map(state.values);
  values.set(id, value);
  return { ...state, values };
}

export const valueOf = (state: FormState, id: number): FormValue => state.values.get(id) ?? NO_VALUE;

export function isDirty(state: FormState, id: number): boolean {
  return !sameValue(valueOf(state, id), state.original.get(id) ?? NO_VALUE);
}

/** Ids whose value differs from the file's, ascending. */
export function dirtyIds(state: FormState): number[] {
  return [...state.values.keys()].filter((id) => isDirty(state, id)).sort((a, b) => a - b);
}

/** Back to the file's values. */
export const resetForm = (state: FormState): FormState => ({ ...state, values: state.original });
