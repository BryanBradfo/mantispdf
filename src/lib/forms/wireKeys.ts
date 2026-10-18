/**
 * The keys of the form wire contract with `crates/mantis-wasm/src/forms/binding.rs`, for the
 * tests (formWire.test.ts checks them against the binding source, formWasm.test.ts against
 * the built engine). `read_values` reads entries and values; `form_to_js` writes the rest.
 */
export const ENTRY_KEYS = ["id", "value"] as const;
export const VALUE_KEYS = { text: ["kind", "text"], names: ["kind", "names"], none: ["kind"] } as const;
/** What `list_form` returns. */
export const INFO_KEYS = ["xfa", "fields"] as const;
export const FIELD_KEYS = ["id", "name", "label", "kind", "readOnly", "required", "value", "options", "onStates", "widgets"] as const;
export const WIDGET_KEYS = ["page", "rect", "rotation", "onState", "hidden", "fontSize", "align"] as const;
export const OPTION_KEYS = ["exportValue", "display"] as const;
export const KIND_KEYS = {
  text: ["kind", "multiline", "comb", "maxLen", "password"],
  checkbox: ["kind"],
  radio: ["kind"],
  combo: ["kind", "editable"],
  list: ["kind", "multi"],
  signature: ["kind"],
  button: ["kind"],
} as const;
export const XFA = ["none", "hybrid", "pure"] as const;

