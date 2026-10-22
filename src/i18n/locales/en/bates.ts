import type { Namespace } from "../../types";

export default {
  seoTitle: "Bates Numbering for PDF | MantisPDF",
  seoDescription: "Add Bates numbers across one or many PDFs, continuing the count from file to file. Free, private, nothing is uploaded.",
  heading: "Bates numbering",
  intro: "Stamp a running identifier on every page, continuing across documents. Everything stays on your device.",
  files: { one: "{count} file. Drag to set the numbering order.", other: "{count} files. Drag to set the numbering order." },
  prefix: "Prefix",
  suffix: "Suffix",
  startNumber: "Start number",
  digits: "Digits",
  needFile: "Add at least one PDF.",
  startRange: "Start number must be a whole number, 0 or more.",
  tooLarge: "Start number plus total pages is too large.",
  digitsRange: "Digits must be between 1 and 12.",
  range: "{first} to {last}",
  numbering: "Numbering…",
  submitZip: "Add Bates numbers and download ZIP",
  submit: "Add Bates numbers and download",
} as const satisfies Namespace;
