import type { Namespace } from "../../types";

// English is the source of truth. Keep `as const`: placeholder and tag names are read from
// these literals to type `t()` params.
export default {
  // Errors (describeError)
  errorGeneric: "Something went wrong while processing the PDF.",
  errorDetails: "Details",
  errorWrongPassword: "Wrong password",
  errorLocked: "This PDF is password-protected. Unlock it first.",
  errorLockedNth: "PDF {n} is password-protected. Unlock it first.",
  errorUnsupportedChars: "Characters not supported by the standard PDF fonts: {chars}",
  errorEngineCrashed: "PDF engine crashed",
  errorEngineUnreadable: "PDF engine sent an unreadable message",
  errorNoCanvas: "Canvas is not available",
  errorNoDecoder: "Image decoding is not supported in this browser",
  errorDecodeTooLarge: "Image is too large to decode (limit 100 megapixels)",

  // Engine and file input (every tool)
  engineFailed: "WASM engine failed to load: {error}",
  engineFailedReload: "PDF engine failed to load. Please reload the page.",
  engineLoading: "Engine is still loading, please wait a moment.",
  invalidPdf: "Please upload a PDF file.",
  readFailed: "Failed to read this PDF.",
  readFailedNamed: "Failed to read {name}.",
  fileProblem: "{name}: {problem}",
  loadingPdf: "Loading PDF…",
  previewLoadingText: "Loading preview…",
  fileWithPages: { one: "{name} · {count} page", other: "{name} · {count} pages" },
  fileWithPagesParen: { one: "{name} ({count} page)", other: "{name} ({count} pages)" },

  // Worker progress steps (describeProgress)
  progressStarting: "Starting…",
  progressSplitting: "Splitting into {parts} parts…",
  progressExtracting: "Extracting part {part} of {of}…",
  progressPreparing: "Preparing download…",
  progressMerging: "Merging {count} documents…",
  progressDone: "Done",

  // Drag and drop (SortableGrid, screen readers)
  dragItem: "item",
  dragInstructions:
    "To pick up a draggable item, press the space bar. While dragging, use the arrow keys to move the item. Press space again to drop the item in its new position, or press escape to cancel.",
  dragPickedUp: "Picked up {name}, position {position} of {count}.",
  dragOver: "{name} is over position {position}.",
  dragDropped: "Dropped {name} at position {position}.",
  dragDroppedNowhere: "Dropped {name}.",
  dragCancelled: "Cancelled. {name} returned to position {position}.",

  // Shared controls
  dismiss: "Dismiss",
  close: "Close",
  reset: "Reset",
  processing: "Processing…",
  download: "Download",
  downloadZip: "Download ZIP",
  newFile: "New file",
  startOver: "Start over",
  chooseAnother: "Choose another file",
  allTools: "← All tools",
  selectAll: "Select all",
  selectNone: "Select none",
  selection: "Selection",
  retry: "Retry",

  // Failures (LocaleProvider, ErrorBoundary)
  localeLoadFailed: "The French version could not be loaded, so this page is shown in English.",
  crashTitle: "Something went wrong on this page.",
  crashReload: "Reload the page",

  // ProgressOverlay
  progressError: "Error",
  progressProcessing: "Processing",
  progressWorking: "Working…",

  // DropZone
  dropPdf: "Drop your PDF here or <browse>browse</browse>",
  dropPdfs: "Drop your PDFs here or <browse>browse</browse>",
  dropImage: "Drop your image here or <browse>browse</browse>",
  dropImages: "Drop your images here or <browse>browse</browse>",
  dropHintPdf: "PDF files",

  // PageImage, PageStrip
  previewLoading: "Loading preview",
  previewUnavailable: "Preview unavailable",
  pagesGroup: "Pages",
  pageN: "Page {n}",
  pageNMarked: "Page {n}, {mark}",
  pageEdited: "edited",

  // Header, language switcher, French banner
  headerStar: "Star",
  toggleDarkMode: "Toggle dark mode",
  language: "Language",
  languageEnglish: "English",
  languageFrench: "Français",
  // Shown to French-speaking browsers on English pages, so it is written in French here too.
  bannerFrench: "Version française disponible.",
  bannerFrenchLink: "Afficher en français",
  bannerFrenchDismiss: "Non merci",

  // Footer
  footerPrivacy: "MantisPDF. All processing happens in your browser. No data is uploaded.",
  footerGithub: "MantisPDF on GitHub",

  // 404
  notFoundTitle: "Page not found",
  notFoundBody: "That page doesn’t exist. Let’s get you back to the PDF tools.",
  notFoundBack: "← Back to all tools",

  // Desktop title bar
  windowClose: "Close window",
  windowMinimize: "Minimize window",
  windowRestore: "Restore window",
  windowMaximize: "Maximize window",

  // License dialog (desktop)
  licenseDialog: "MantisPDF Pro license",
  licenseActiveTitle: "MantisPDF Pro is active",
  licenseActiveBody:
    "Math OCR and the live LaTeX preview are unlocked. Thank you for supporting local-first software.",
  licenseDeactivate: "Deactivate on this device",
  licenseUnlockTitle: "Unlock MantisPDF Pro",
  licenseUnlockBody:
    "Pro adds offline math OCR: convert equations to perfect LaTeX, rendered live. Enter your license key to activate.",
  licenseActivating: "Activating…",
  licenseActivate: "Activate license",
  licenseGetKey: "Don't have a key? Get MantisPDF Pro →",
} as const satisfies Namespace;
