import type { Namespace } from "../../types";

export default {
  seoTitle: "Encrypt PDF | MantisPDF",
  seoDescription: "Password-protect your PDF so only authorized readers can open it. Client-side only, nothing is uploaded.",
  heading: "Encrypt PDF",
  intro: "Set a password to restrict who can open your PDF. Processed entirely in your browser.",
  password: "Password",
  passwordPlaceholder: "Enter password",
  confirm: "Confirm password",
  confirmPlaceholder: "Re-enter password",
  mismatch: "Passwords do not match.",
  owner: "Owner password",
  ownerHint: "(optional, restricts editing/printing)",
  ownerPlaceholder: "Leave blank to use the same password",
  submit: "Encrypt PDF",
  cancel: "Cancel",
  encrypting: "Encrypting…",
  done: "PDF encrypted successfully.",
  doneHint: "Open the downloaded file in any PDF reader and it will prompt for your password.",
  download: "Download encrypted PDF",
  another: "Encrypt another",
} as const satisfies Namespace;
