import type { Namespace } from "../../types";

export default {
  // RangeInput and parsePageRanges
  rangePlaceholder: "e.g. 1-3, 7, 10-",
  rangeHelp: "Click pages or type ranges.",
  rangeUnreadable: "Cannot read \"{text}\"",
  rangeStartsAt1: "Page numbers start at 1",
  rangeNoSuchPage: {
    one: "Page {page} does not exist (the document has {count} page)",
    other: "Page {page} does not exist (the document has {count} pages)",
  },
  rangeBackwards: "Range {start}-{end} is backwards",

  // describePages
  pagesAll: { one: "All {count} pages", other: "All {count} pages" },
  pagesOne: "Page {page} of {total}",
  pagesSome: "{count} of {total} pages",

  // Planner cards (Organize, Remove, Extract)
  blankPage: "Blank page",
  captionPage: "Page {page}",
  captionSourcePage: "{name} · {page}",
  rotateLeft: "Rotate left",
  rotateLeftItem: "Rotate {caption} left",
  rotateRight: "Rotate right",
  rotateRightItem: "Rotate {caption} right",
  duplicate: "Duplicate",
  duplicateItem: "Duplicate {caption}",
  insertBlank: "Insert blank page after",
  insertBlankItem: "Insert blank page after {caption}",
  delete: "Delete",
  deleteItem: "Delete {caption}",
  removeItem: "Remove {caption}",
  extractItem: "Extract {caption}",
  // A page of a single document (the caption would be "Page N").
  removePage: "Remove Page {page}",
  extractPage: "Extract Page {page}",

  // Remove / Extract pages (shared)
  everythingLocal: "Everything runs in your browser.",
  perPageZip: "One file per page (ZIP)",
  resultOf: {
    one: "{name} · {result} of {count} page in the result",
    other: "{name} · {result} of {count} pages in the result",
  },
  mustRemain: "(at least one page must remain)",
} as const satisfies Namespace;
