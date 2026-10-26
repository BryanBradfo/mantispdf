import type { Namespace } from "../../types";

export default {
  position: "Position",
  // PositionPicker
  "anchor.top-left": "Top left",
  "anchor.top-center": "Top center",
  "anchor.top-right": "Top right",
  "anchor.middle-left": "Middle left",
  "anchor.center": "Center",
  "anchor.middle-right": "Middle right",
  "anchor.bottom-left": "Bottom left",
  "anchor.bottom-center": "Bottom center",
  "anchor.bottom-right": "Bottom right",
  // Header and footer slots
  "slot.top-left": "Header left",
  "slot.top-center": "Header center",
  "slot.top-right": "Header right",
  "slot.bottom-left": "Footer left",
  "slot.bottom-center": "Footer center",
  "slot.bottom-right": "Footer right",
  // TextStyleFields
  font: "Font",
  size: "Size (pt)",
  colour: "Colour",
  opacity: "Opacity ({percent})",
  styleSummary: "{font} {size} pt",
  // Shared settings
  firstNumber: "First number",
  marginFromEdge: "Margin from the edge (pt)",
  sizeRange: "Size must be between 6 and 72 pt.",
  marginRange: "Margin must be between 0 and 300 pt.",
  firstNumberRange: "First number must be a whole number, 0 or more.",
  // Text printed on the page: the tokens are passed back as their own values ({ n: "{n}" }).
  templatePage: "Page {n}",
  templatePageOf: "Page {n} of {total}",
} as const satisfies Namespace;
