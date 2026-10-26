import type { ComponentType } from "react";
import { DEFAULT_LOCALE, loadLocale, localeFromPath, stripLocale, type Locale } from "./i18n";

type PageModule = { default: ComponentType };

/** One chunk per page, by English path. `routes.tsx` builds its lazy pages from these. */
export const PAGE_LOADERS: Record<string, () => Promise<PageModule>> = {
  "/": () => import("./pages/HomePage"),
  "/split": () => import("./pages/SplitPdfPage"),
  "/merge": () => import("./pages/MergePdfPage"),
  "/compress": () => import("./pages/CompressPdfPage"),
  "/rotate": () => import("./pages/RotatePdfPage"),
  "/edit-pdf": () => import("./pages/EditPdfPage"),
  "/fill-form": () => import("./pages/FillFormPage"),
  "/redact": () => import("./pages/RedactPage"),
  "/ocr": () => import("./pages/OcrPage"),
  "/organize": () => import("./pages/OrganizePdfPage"),
  "/remove-pages": () => import("./pages/RemovePagesPage"),
  "/extract-pages": () => import("./pages/ExtractPagesPage"),
  "/pdf-to-image": () => import("./pages/PdfToImagePage"),
  "/watermark": () => import("./pages/WatermarkPdfPage"),
  "/encrypt": () => import("./pages/EncryptPdfPage"),
  "/sanitize": () => import("./pages/SanitizePdfPage"),
  "/remove-metadata": () => import("./pages/RemoveMetadataPage"),
  "/edit-metadata": () => import("./pages/EditMetadataPage"),
  "/unlock": () => import("./pages/UnlockPdfPage"),
  "/page-numbers": () => import("./pages/PageNumbersPage"),
  "/header-footer": () => import("./pages/HeaderFooterPage"),
  "/bates": () => import("./pages/BatesPage"),
  "/sign": () => import("./pages/SignPdfPage"),
  "/crop": () => import("./pages/CropPdfPage"),
  "/resize": () => import("./pages/ResizePdfPage"),
  "/n-up": () => import("./pages/NupPdfPage"),
  "/images-to-pdf": () => import("./pages/ImagesToPdfPage"),
  "/extract-images": () => import("./pages/ExtractImagesPage"),
};

/** The page chunk of a URL path in any locale (`/fr/merge?x` -> the Merge loader), if it is a page. */
export function routeLoaderFor(path: string): (() => Promise<PageModule>) | undefined {
  const bare = stripLocale(path).split(/[?#]/)[0] || "/";
  return Object.prototype.hasOwnProperty.call(PAGE_LOADERS, bare) ? PAGE_LOADERS[bare] : undefined;
}

/** Starts downloading the page chunk of `path` (the browser keeps it for the lazy page). */
export function preloadRoute(path: string): Promise<unknown> {
  return routeLoaderFor(path)?.() ?? Promise.resolve();
}

/**
 * A first load of a localized URL needs the dictionary and the page chunk: start both now, in
 * parallel, instead of the page chunk waiting for the dictionary (LocaleProvider suspends first).
 */
export function startFirstLoad(
  pathname: string,
  deps: { loadLocale: (locale: Locale) => Promise<unknown>; loadRoute: (path: string) => Promise<unknown> } = {
    loadLocale,
    loadRoute: preloadRoute,
  },
): void {
  const locale = localeFromPath(pathname);
  if (locale === DEFAULT_LOCALE) return;
  void deps.loadLocale(locale).catch(() => undefined);
  void deps.loadRoute(pathname).catch(() => undefined);
}
