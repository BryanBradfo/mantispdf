import type { Namespace } from "../../types";

export default {
  seoTitle: "Sanitize PDF | MantisPDF",
  seoDescription:
    "Strip hidden data from a PDF: metadata, scripts, attachments, form data and hidden content from removed pages. Free, private, nothing is uploaded.",
  heading: "Sanitize PDF",
  intro: "Strip hidden data from a PDF: metadata, scripts, attachments, form data and hidden content from removed pages.",
  keepComments: "Keep comments",
  sanitizing: "Sanitizing…",
  submit: "Sanitize and download",
  fieldsFlattened: "Fields flattened: {count}",
  linksKept: "Links kept: {count}",
  linksRemoved: "Links removed: {count}",
  commentsKept: "Comments kept: {count}",
  commentsRemoved: "Comments removed: {count}",
  imagesCleaned: { one: "{count} image had its metadata removed", other: "{count} images had their metadata removed" },
  notAnalysed: "Some pages could not be fully analysed and kept all their resources.",
  deepDropped: "Some deeply nested content could not be copied.",
} as const satisfies Namespace;
