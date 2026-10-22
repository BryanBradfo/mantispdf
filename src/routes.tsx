import { lazy, type ReactElement } from "react";
import { Link, Navigate, useT } from "./i18n";

const HomePage = lazy(() => import("./pages/HomePage"));
const SplitPdfPage = lazy(() => import("./pages/SplitPdfPage"));
const MergePdfPage = lazy(() => import("./pages/MergePdfPage"));
const CompressPdfPage = lazy(() => import("./pages/CompressPdfPage"));
const RotatePdfPage = lazy(() => import("./pages/RotatePdfPage"));
const OrganizePdfPage = lazy(() => import("./pages/OrganizePdfPage"));
const RemovePagesPage = lazy(() => import("./pages/RemovePagesPage"));
const ExtractPagesPage = lazy(() => import("./pages/ExtractPagesPage"));
const PdfToImagePage = lazy(() => import("./pages/PdfToImagePage"));
const WatermarkPdfPage = lazy(() => import("./pages/WatermarkPdfPage"));
const EncryptPdfPage = lazy(() => import("./pages/EncryptPdfPage"));
const SanitizePdfPage = lazy(() => import("./pages/SanitizePdfPage"));
const RemoveMetadataPage = lazy(() => import("./pages/RemoveMetadataPage"));
const EditMetadataPage = lazy(() => import("./pages/EditMetadataPage"));
const UnlockPdfPage = lazy(() => import("./pages/UnlockPdfPage"));
const PageNumbersPage = lazy(() => import("./pages/PageNumbersPage"));
const HeaderFooterPage = lazy(() => import("./pages/HeaderFooterPage"));
const BatesPage = lazy(() => import("./pages/BatesPage"));
const SignPdfPage = lazy(() => import("./pages/SignPdfPage"));
const CropPdfPage = lazy(() => import("./pages/CropPdfPage"));
const ResizePdfPage = lazy(() => import("./pages/ResizePdfPage"));
const NupPdfPage = lazy(() => import("./pages/NupPdfPage"));
const EditPdfPage = lazy(() => import("./pages/EditPdfPage"));
const FillFormPage = lazy(() => import("./pages/FillFormPage"));
const RedactPage = lazy(() => import("./pages/RedactPage"));
const OcrPage = lazy(() => import("./pages/OcrPage"));
const ImagesToPdfPage = lazy(() => import("./pages/ImagesToPdfPage"));
const ExtractImagesPage = lazy(() => import("./pages/ExtractImagesPage"));

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
