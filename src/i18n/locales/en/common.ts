import type { Namespace } from "../../types";

// English is the source of truth. Keep `as const`: placeholder and tag names are read from
// these literals to type `t()` params.
export default {
  errorGeneric: "Something went wrong while processing the PDF.",
  errorDetails: "Details",
  errorWrongPassword: "Wrong password",
  errorLocked: "This PDF is password-protected. Unlock it first.",
  errorLockedNth: "PDF {n} is password-protected. Unlock it first.",
} as const satisfies Namespace;
