import type { Namespace } from "../../types";

export default {
  seoTitle: "Split PDF Online | MantisPDF",
  seoDescription: "Split a PDF into multiple files instantly. Choose exact split points. Runs in your browser, no upload needed.",
  heading: "Split PDF",
  intro: "Upload a PDF, click the scissors between pages to mark split points, then hit Split.",
  selectPoints: "Select split points below",
  splitInto: "Split into {parts} parts",
  removePoint: "Remove split point",
  splitAfter: "Split after this page",
  removeRow: "Remove all splits in this row",
  splitRow: "Split after every page in this row",
} as const satisfies Namespace;
