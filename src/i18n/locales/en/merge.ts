import type { Namespace } from "../../types";

export default {
  seoTitle: "Merge PDF Files | MantisPDF",
  seoDescription: "Combine multiple PDFs into one document. Drag to reorder pages. Free, private, no upload required.",
  heading: "Merge PDF",
  intro: "Upload multiple PDFs, grab a card to reorder, then merge into a single document.",
  mergeFiles: { one: "Merge {count} file", other: "Merge {count} files" },
  files: { one: "{count} file", other: "{count} files" },
  totalPages: { one: "{count} total page", other: "{count} total pages" },
  pages: { one: "{count} page", other: "{count} pages" },
  firstPageOf: "First page of {name}",
  removeFile: "Remove file",
  removeNamed: "Remove {name}",
  moveLeft: "Move left",
  moveRight: "Move right",
} as const satisfies Namespace;
