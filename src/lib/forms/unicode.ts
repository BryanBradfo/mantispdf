/**
 * Field values the standard fonts cannot encode: they are drawn with the Noto family matching the
 * field's /DA font (Helvetica -> Noto Sans, Times -> Noto Serif, Courier -> Noto Sans Mono) with
 * per-character fallback, like Edit PDF text boxes (spec 1.6). This module picks the fonts the
 * engine gets (`fill_form`'s `fonts`) and judges overflow from the engine's own layout.
 */
import { unsupportedChars } from "../editor/afm";
import { planFonts, resolveFont, type FontPlan } from "../editor/unicodeText";
import type { NotoFamily } from "../editor/model";
import type { FontManifest } from "../fonts/manifest";
import type { CjkFlavour } from "../fonts/select";
import type { TextLayout } from "../fonts/jobFonts";
import { LEADING, PADDING, widgetFrame } from "./layout";
import { isDrawn, valueOf, type FormField, type FormState, type FormValue, type FormWidget } from "./model";
import { shownText } from "./values";

/** The fonts of a fill job, by file name; the worker attaches the bytes. */
export interface FormFontsWire {
  files: string[];
  fields: { field: number; faces: string[]; fakeBold: string[] }[];
}

const isTextLike = (f: FormField) => f.kind.kind === "text" || f.kind.kind === "combo";

/** What a field's appearance draws: its value's text, or every option of a list box (its rows). */
function drawnText(field: FormField, value: FormValue): string {
  return field.kind.kind === "list" ? field.options.map((o) => o.display).join("\n") : shownText(field, value);
}

/** The Noto family a field's value needs, or null when its standard font can draw it. */
export function notoFamily(field: FormField, value: FormValue): { family: NotoFamily; bold: boolean } | null {
  if (!isTextLike(field) && field.kind.kind !== "list") return null;
  const text = drawnText(field, value);
  if (unsupportedChars(text.replace(/[\r\n\t]/g, " ")) === "") return null;
  const font = field.widgets[0]?.font ?? "Helvetica";
  const resolved = resolveFont(font, text);
  return resolved.kind === "noto" ? { family: resolved.family, bold: resolved.bold } : null;
}

/** The fonts a field's value is drawn with (null: its standard font). */
export function fieldPlan(field: FormField, value: FormValue, manifest: FontManifest, cjk: CjkFlavour): FontPlan | null {
  const noto = notoFamily(field, value);
  return noto ? planFonts(manifest, drawnText(field, value), noto.family, noto.bold, cjk) : null;
}

/** Characters of a field's value no font can show ("" until the font list is known). */
export function uncoveredIn(field: FormField, value: FormValue, manifest: FontManifest | null, cjk: CjkFlavour): string {
  if (!manifest) return "";
  return fieldPlan(field, value, manifest, cjk)?.missing ?? "";
}

/** "Uses Noto Sans for these characters" when the value switches the field to a Noto family. */
export function notoNotice(field: FormField, value: FormValue): string | null {
  const noto = notoFamily(field, value);
  return noto ? `Uses ${noto.family} for these characters` : null;
}

/** The fonts of every field whose value (changed or kept) needs Noto, or undefined when none does. */
export function formFonts(fields: readonly FormField[], state: FormState, manifest: FontManifest, cjk: CjkFlavour): FormFontsWire | undefined {
  const files: string[] = [];
  const out: FormFontsWire["fields"] = [];
  for (const field of fields) {
    const plan = fieldPlan(field, valueOf(state, field.id), manifest, cjk);
    if (!plan || plan.faces.length === 0) continue;
    const faces = plan.faces.map((f) => f.file);
    for (const file of faces) if (!files.includes(file)) files.push(file);
    out.push({ field: field.id, faces, fakeBold: plan.fakeBold.map((f) => f.file) });
  }
  return out.length === 0 ? undefined : { files, fields: out };
}

/** Smallest automatic size (`MIN_AUTO_SIZE`): an automatic size never goes below it. */
const MIN_AUTO_SIZE = 4;
/** Height asked of the engine when a layout must not be clipped. */
const UNCLIPPED = 100_000;

/** The engine layout that tells whether a Noto value overflows `widget` (the smallest size it can get). */
export function overflowRequest(field: FormField, widget: FormWidget, text: string, plan: FontPlan) {
  const { width } = widgetFrame(widget);
  const multiline = field.kind.kind === "text" && field.kind.multiline;
  const size = widget.fontSize > 0 ? widget.fontSize : MIN_AUTO_SIZE;
  return {
    fonts: plan.faces.map((f) => f.file),
    text,
    size,
    width: multiline ? Math.max(1, width - 2 * PADDING) : UNCLIPPED,
    height: UNCLIPPED,
    align: "left",
    lineHeight: LEADING,
  };
}

/** Whether the engine's lines (from `overflowRequest`) are cut off by the widget. */
export function overflowsLayout(field: FormField, widget: FormWidget, layout: TextLayout): boolean {
  const { width, height } = widgetFrame(widget);
  if (field.kind.kind === "text" && field.kind.comb && field.kind.maxLen !== null) return false;
  if (field.kind.kind === "text" && field.kind.multiline) return 2 * PADDING + layout.height > height + 1e-9;
  const lineWidth = Math.max(0, ...layout.lines.map((l) => l.runs.reduce((w, r) => Math.max(w, r.x + r.width), 0)));
  return lineWidth > width - 2 * PADDING + 1e-9;
}

/** The first drawn widget of a field (what the overflow check measures). */
export const firstDrawn = (field: FormField): FormWidget | undefined => field.widgets.find(isDrawn);
