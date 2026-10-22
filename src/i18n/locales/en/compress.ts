import type { Namespace } from "../../types";

export default {
  seoTitle: "Compress PDF: Reduce File Size | MantisPDF",
  seoDescription: "Reduce PDF file size by compressing images and streams. No upload, no data sent to any server.",
  heading: "Compress PDF",
  intro: "Reduce file size by downsampling and re-encoding images, stripping metadata, and compressing streams, no upload required.",
  compressing: "Compressing…",
  original: "Original",
  compressed: "Compressed",
  savedLess: "-{percent}",
  savedMore: "+{percent}",
  savedNone: "~0%",
  smaller: "smaller",
  larger: "larger",
  noChange: "no change",
  download: "Download compressed PDF",
  another: "Compress another",
} as const satisfies Namespace;
