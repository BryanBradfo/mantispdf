import type { Namespace } from "../../types";

export default {
  seoTitle: "Add Page Numbers to PDF | MantisPDF",
  seoDescription: "Add page numbers to a PDF: choose position, format and font. Free, private, nothing is uploaded.",
  heading: "Add page numbers",
  intro: "Number the pages of a PDF, in the corner you choose. Everything stays on your device.",
  format: "Format",
  custom: "Custom…",
  customText: "Custom text (use {n}, {total}, {date}, {filename})",
  rangeLabel: "Pages to number",
  needFormat: "Enter a format for the page number.",
  numbering: "Numbering…",
  submit: "Add numbers and download",
} as const satisfies Namespace;
