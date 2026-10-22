import type { Namespace } from "../../types";

export default {
  seoTitle: "Rotate PDF Pages | MantisPDF",
  seoDescription: "Rotate individual pages or entire PDF documents online. Client-side processing, nothing is uploaded.",
  heading: "Rotate Pages",
  intro: "Upload a PDF and rotate individual pages or the entire document. All processing happens in your browser.",
  allCcw: "↺ All CCW",
  allCcwLabel: "Rotate all pages 90° counter-clockwise",
  allCw: "↻ All CW",
  allCwLabel: "Rotate all pages 90° clockwise",
  resetAll: "Reset All",
  ccw: "Rotate counter-clockwise",
  ccwPage: "Rotate page {n} 90° counter-clockwise",
  cw: "Rotate clockwise",
  cwPage: "Rotate page {n} 90° clockwise",
} as const satisfies Namespace;
