import { dirtyIds, valueOf, type FormState, type FormValue } from "./model";

/**
 * One fill value as `crates/mantis-wasm/src/forms/binding.rs` `read_values`
 * reads it.
 */
export interface FormWireEntry {
  id: number;
  value: FormValue;
}

/** A copy holding exactly the wire keys of `value`. */
function wireValue(value: FormValue): FormValue {
  switch (value.kind) {
    case "text":
      return { kind: "text", text: value.text };
    case "names":
      return { kind: "names", names: [...new Set(value.names)] };
    case "none":
      return { kind: "none" };
  }
}

/** Only the values that differ from the file's, by ascending id. */
export function toWire(state: FormState): FormWireEntry[] {
  return dirtyIds(state).map((id) => ({ id, value: wireValue(valueOf(state, id)) }));
}
