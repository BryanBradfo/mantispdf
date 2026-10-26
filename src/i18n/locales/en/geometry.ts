import type { Namespace } from "../../types";

export default {
  sheetSize: "Sheet size",
  sameAsFirst: "Same as first page",
  fitToImage: "Fit to image",
  paperOption: "{name} ({width} x {height} mm)",
  custom: "Custom…",
  width: "Width (mm)",
  height: "Height (mm)",
  orientation: "Orientation",
  portrait: "Portrait",
  landscape: "Landscape",
  margin: "Margin (mm)",
  fixSettings: "Fix the settings to see a preview.",
  // Words inside a settings summary
  wordAuto: "auto",
  wordPortrait: "portrait",
  wordLandscape: "landscape",
  // Layout problems (geometryLayout)
  customSize: "Custom size must be between 13 and 5080 mm on each side.",
  marginRange: "Margin must be between 0 and 200 mm.",
  noRoom: "The margin leaves no room on the sheet. Use a smaller margin.",
  selectAtLeastOne: "Select at least one page.",
  firstPageSize: "The first page is too small or too large to be the sheet size (1 to 200 in). Pick a paper size.",
  gapRange: "Gap must be between 0 and 200 mm.",
  noRoomPages: "The margin and gap leave no room for the pages.",
  mmSize: "{width} x {height} mm",
} as const satisfies Namespace;
