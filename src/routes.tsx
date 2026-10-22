import { lazy, type ReactElement } from "react";
import { Link, Navigate, useT } from "./i18n";
import { PAGE_LOADERS } from "./firstLoad";

const HomePage = lazy(PAGE_LOADERS["/"]);
const SplitPdfPage = lazy(PAGE_LOADERS["/split"]);
const MergePdfPage = lazy(PAGE_LOADERS["/merge"]);
const CompressPdfPage = lazy(PAGE_LOADERS["/compress"]);
const RotatePdfPage = lazy(PAGE_LOADERS["/rotate"]);
const OrganizePdfPage = lazy(PAGE_LOADERS["/organize"]);
const RemovePagesPage = lazy(PAGE_LOADERS["/remove-pages"]);
const ExtractPagesPage = lazy(PAGE_LOADERS["/extract-pages"]);
const PdfToImagePage = lazy(PAGE_LOADERS["/pdf-to-image"]);
const WatermarkPdfPage = lazy(PAGE_LOADERS["/watermark"]);
const EncryptPdfPage = lazy(PAGE_LOADERS["/encrypt"]);
const SanitizePdfPage = lazy(PAGE_LOADERS["/sanitize"]);
const RemoveMetadataPage = lazy(PAGE_LOADERS["/remove-metadata"]);
const EditMetadataPage = lazy(PAGE_LOADERS["/edit-metadata"]);
const UnlockPdfPage = lazy(PAGE_LOADERS["/unlock"]);
const PageNumbersPage = lazy(PAGE_LOADERS["/page-numbers"]);
const HeaderFooterPage = lazy(PAGE_LOADERS["/header-footer"]);
const BatesPage = lazy(PAGE_LOADERS["/bates"]);
const SignPdfPage = lazy(PAGE_LOADERS["/sign"]);
const CropPdfPage = lazy(PAGE_LOADERS["/crop"]);
const ResizePdfPage = lazy(PAGE_LOADERS["/resize"]);
const NupPdfPage = lazy(PAGE_LOADERS["/n-up"]);
const EditPdfPage = lazy(PAGE_LOADERS["/edit-pdf"]);
const FillFormPage = lazy(PAGE_LOADERS["/fill-form"]);
const RedactPage = lazy(PAGE_LOADERS["/redact"]);
const OcrPage = lazy(PAGE_LOADERS["/ocr"]);
const ImagesToPdfPage = lazy(PAGE_LOADERS["/images-to-pdf"]);
const ExtractImagesPage = lazy(PAGE_LOADERS["/extract-images"]);

function NotFound() {
  const t = useT("common");
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <p className="text-5xl font-black text-mantis-500">404</p>
      <h1 className="mt-4 text-2xl font-bold text-gray-900 dark:text-[#e5e5e5]">{t("notFoundTitle")}</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        {t("notFoundBody")}
      </p>
      <Link
        to="/"
        className="mt-6 rounded-lg bg-mantis-500 px-4 py-2 font-medium text-white hover:bg-mantis-600"
      >
        {t("notFoundBack")}
      </Link>
    </div>
  );
}

export interface AppRoute {
  path: string;
  element: ReactElement;
}

/** A legacy path kept only to redirect (not a page of its own: left out of the sitemap). */
export function isRedirect(route: AppRoute): boolean {
  return route.element.type === Navigate;
}

/**
 * Every client route, in English (root) form. App renders this table once per locale
 * (`localizeRoutes`: `/merge` and `/fr/merge` share an element). Paths are absolute; `Link` and
 * `Navigate` from `./i18n` keep the current locale prefix.
 */
export const APP_ROUTES: readonly AppRoute[] = [
  { path: "/", element: <HomePage /> },
  { path: "/split", element: <SplitPdfPage /> },
  { path: "/merge", element: <MergePdfPage /> },
  { path: "/compress", element: <CompressPdfPage /> },
  { path: "/rotate", element: <RotatePdfPage /> },
  { path: "/edit", element: <Navigate to="/organize" replace /> },
  { path: "/edit-pdf", element: <EditPdfPage /> },
  { path: "/fill-form", element: <FillFormPage /> },
  { path: "/redact", element: <RedactPage /> },
  { path: "/ocr", element: <OcrPage /> },
  { path: "/organize", element: <OrganizePdfPage /> },
  { path: "/remove-pages", element: <RemovePagesPage /> },
  { path: "/extract-pages", element: <ExtractPagesPage /> },
  { path: "/pdf-to-image", element: <PdfToImagePage /> },
  { path: "/watermark", element: <WatermarkPdfPage /> },
  { path: "/encrypt", element: <EncryptPdfPage /> },
  { path: "/sanitize", element: <SanitizePdfPage /> },
  { path: "/remove-metadata", element: <RemoveMetadataPage /> },
  { path: "/edit-metadata", element: <EditMetadataPage /> },
  { path: "/unlock", element: <UnlockPdfPage /> },
  { path: "/page-numbers", element: <PageNumbersPage /> },
  { path: "/header-footer", element: <HeaderFooterPage /> },
  { path: "/bates", element: <BatesPage /> },
  { path: "/sign", element: <SignPdfPage /> },
  { path: "/crop", element: <CropPdfPage /> },
  { path: "/resize", element: <ResizePdfPage /> },
  { path: "/n-up", element: <NupPdfPage /> },
  { path: "/images-to-pdf", element: <ImagesToPdfPage /> },
  { path: "/jpg-to-pdf", element: <Navigate to="/images-to-pdf" replace /> },
  { path: "/extract-images", element: <ExtractImagesPage /> },
  { path: "*", element: <NotFound /> },
];
