import { createContext, useContext } from "react";
import type { FormField, FormValue } from "../../lib/forms/model";

/** What the form controls need to know about values drawn with Noto fonts. */
export interface FormFontsEnv {
  /** Characters of a value no font can show. */
  uncovered: (field: FormField, value: FormValue) => string;
  /** Whether a Noto value overflows its field, from the engine's layout (undefined: not measured). */
  overflow: (fieldId: number) => boolean | undefined;
}

export const FormFontsContext = createContext<FormFontsEnv | null>(null);

export function useFormFonts(): FormFontsEnv | null {
  return useContext(FormFontsContext);
}
