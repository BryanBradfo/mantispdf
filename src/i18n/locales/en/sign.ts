import type { Namespace } from "../../types";

export default {
  seoTitle: "Sign PDF: Add Your Signature | MantisPDF",
  seoDescription: "Sign a PDF in your browser: draw, type or upload your signature and place it on the page. Free, private, nothing is uploaded.",
  heading: "Sign PDF",
  intro: "Draw, type or upload your signature and place it on any page. Everything stays on your device.",
  stepCreate: "Create your signature",
  stepPage: "Choose the page",
  stepPlace: "Place it",
  // Printed on the page: {date} is a stamp token, passed back as itself.
  signedOn: "Signed on {date}",
  addDate: "Add \"{text}\" under the signature",
  signing: "Signing…",
  submit: "Sign and download",
  visualOnly: "This adds a visual signature, not a cryptographic one.",
  // SignaturePad
  source: "Signature source",
  draw: "Draw",
  type: "Type",
  upload: "Upload",
  drawArea: "Signature drawing area",
  clear: "Clear",
  drawHint: "Sign with your mouse, finger or stylus.",
  yourName: "Your name",
  namePlaceholder: "Jane Doe",
  style: "Style",
  sample: "Signature",
  imageLabel: "Signature image (PNG or JPG)",
  removeWhite: "Remove white background",
  uploaded: "Uploaded signature",
  notImage: "Choose a PNG or JPG image.",
  nothingLeft: "Nothing is left once the white background is removed.",
  transparent: "This image is fully transparent.",
  unreadable: "Could not read this image.",
  // PlacementCanvas
  noVisibleArea: "This page has no visible area to sign on.",
  movable: "movable signature",
  positionLabel: "Signature position",
  placementHelp:
    "Drag the signature to move it, drag its corner to resize. Arrow keys move it by 1 pt, + and - resize it (Shift: 10 pt).",
  describe: "Signature {width} by {height} pt, {x} pt from the left, {top} pt from the top.",
} as const satisfies Namespace;
