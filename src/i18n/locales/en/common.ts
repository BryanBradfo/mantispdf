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

  // Shared controls
  dismiss: "Dismiss",
  close: "Close",
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
