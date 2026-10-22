import type { Namespace } from "../../types";

export default {
  seoTitle: "Resize PDF Pages | MantisPDF",
  seoDescription: "Resize PDF pages to A4, Letter or a custom size, scaling the content to fit. Free, private, nothing is uploaded.",
  heading: "Resize pages",
  intro: "Change the page size of a PDF and scale the content to fit. Everything stays on your device.",
  orientationAuto: "Auto (follow each page)",
  mode: "Mode",
  fitOption: "Fit (scale up or down)",
  extendOption: "Extend (never enlarge)",
  fitWord: "Fit",
  extendWord: "Extend",
  summary: "{paper} · {orientation} · {mode} · margin {margin} mm · {pages}",
  preview: "Preview",
  previewPage: "Preview (page {page})",
  previewLabel: "One page placed on the target sheet",
  rangeLabel: "Pages to resize",
  resizing: "Resizing…",
  submit: "Resize and download",
} as const satisfies Namespace;
