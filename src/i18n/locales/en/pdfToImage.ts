import type { Namespace } from "../../types";

export default {
  seoTitle: "PDF to Images: Export Pages as PNG or JPEG | MantisPDF",
  seoDescription: "Convert each PDF page to a PNG or JPEG image. No upload, no data sent to any server.",
  heading: "PDF to Images",
  intro: "Export each page of your PDF as a PNG or JPEG image. All processing happens locally in your browser.",
  selectedFile: "Selected file",
  format: "Format",
  resolution: "Resolution",
  scale: "{scale}× ({dpi} dpi)",
  convert: "Convert to images",
  converting: "Converting page {page} of {total}…",
  noCanvas: "Could not get a 2D canvas context",
  renderFailed: "Failed to render page to image (page may exceed the browser's canvas size limit, so try a lower scale)",
} as const satisfies Namespace;
