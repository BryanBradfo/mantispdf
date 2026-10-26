import type { Namespace } from "../../types";

export default {
  seoTitle: "Add Header and Footer to PDF | MantisPDF",
  seoDescription: "Add a header and footer to every page of a PDF, with page numbers, date and file name. Free, private, nothing is uploaded.",
  heading: "Header and footer",
  intro: "Add text at the top and bottom of your pages. Everything stays on your device.",
  tokens:
    "Tokens: {n} number (counts from the first selected page, starting at First number), {total} number printed on the last selected page, {date}, {filename}",
  pages: "Pages",
  onPage: "On page {page}:",
  slotPreview: "{label}: ",
  empty: "(empty)",
  none: "none",
  needText: "Fill in at least one header or footer field.",
  summary: { one: "{count} text ({slots}) · {pages} · {style}", other: "{count} texts ({slots}) · {pages} · {style}" },
  stamping: "Stamping…",
  submit: "Add and download",
} as const satisfies Namespace;
