import type { Namespace } from "../../types";

export default {
  seoTitle: "Organize PDF Pages | MantisPDF",
  seoDescription: "Reorder, rotate, duplicate, delete and insert blank pages across several PDFs. Free, private, nothing is uploaded.",
  heading: "Organize PDF",
  intro: "Drop one or more PDFs, then drag pages into place, rotate, duplicate, delete or add blank pages.",
  pagesInResult: { one: "{count} page in the result", other: "{count} pages in the result" },
  files: { one: "{count} file", other: "{count} files" },
  addBlank: "Add blank page",
  downloadPdf: "Download PDF",
  needOnePage: "Add at least one page from a document to download.",
} as const satisfies Namespace;
