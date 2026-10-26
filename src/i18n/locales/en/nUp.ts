import type { Namespace } from "../../types";

export default {
  seoTitle: "N-up PDF: Several Pages per Sheet | MantisPDF",
  seoDescription: "Put 2, 4, 6, 8, 9 or 16 PDF pages on each sheet. Free, private, nothing is uploaded.",
  heading: "N-up pages",
  intro: "Place several pages on each sheet, for handouts or saving paper. Everything stays on your device.",
  orientationAuto: "Auto (landscape for 2 and 8)",
  perSheet: "Pages per sheet",
  order: "Order",
  rows: "Rows (left to right, then down)",
  columns: "Columns (top to bottom, then right)",
  rowsWord: "rows",
  columnsWord: "columns",
  gap: "Gap (mm)",
  border: "Draw a border around each page",
  previewFirst: "Preview (first sheet)",
  firstSheetLabel: "First sheet with {n} pages",
  note: "Note: comments, links and form fields are not carried to the sheets. Only the visible page content is.",
  sameAsFirst: "same as first page",
  summary: {
    one: "{perSheet} per sheet · {paper} · {orientation} · {order} · margin {margin} mm, gap {gap} mm · {count} sheet",
    other: "{perSheet} per sheet · {paper} · {orientation} · {order} · margin {margin} mm, gap {gap} mm · {count} sheets",
  },
  blankPages: {
    one: "Page {list} could not be read and was left blank on the sheets.",
    other: "Pages {list} could not be read and were left blank on the sheets.",
  },
  arranging: "Arranging…",
  submit: "Arrange and download",
} as const satisfies Namespace;
