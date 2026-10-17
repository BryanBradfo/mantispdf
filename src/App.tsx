import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Link, Navigate } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import TitleBar from "./components/desktop/TitleBar";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";

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
const ImagesToPdfPage = lazy(() => import("./pages/ImagesToPdfPage"));
const ExtractImagesPage = lazy(() => import("./pages/ExtractImagesPage"));

function PageSpinner() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <p className="text-5xl font-black text-mantis-500">404</p>
      <h1 className="mt-4 text-2xl font-bold text-gray-900 dark:text-[#e5e5e5]">Page not found</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        That page doesn’t exist. Let’s get you back to the PDF tools.
      </p>
      <Link
        to="/"
        className="mt-6 rounded-lg bg-mantis-500 px-4 py-2 font-medium text-white hover:bg-mantis-600"
      >
        ← Back to all tools
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen flex-col">
        <TitleBar />
        <Header />
        <main className="flex-1">
          <Suspense fallback={<PageSpinner />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/split" element={<SplitPdfPage />} />
              <Route path="/merge" element={<MergePdfPage />} />
              <Route path="/compress" element={<CompressPdfPage />} />
              <Route path="/rotate" element={<RotatePdfPage />} />
              <Route path="/edit" element={<Navigate to="/organize" replace />} />
              <Route path="/organize" element={<OrganizePdfPage />} />
              <Route path="/remove-pages" element={<RemovePagesPage />} />
              <Route path="/extract-pages" element={<ExtractPagesPage />} />
              <Route path="/pdf-to-image" element={<PdfToImagePage />} />
              <Route path="/watermark" element={<WatermarkPdfPage />} />
              <Route path="/encrypt" element={<EncryptPdfPage />} />
              <Route path="/sanitize" element={<SanitizePdfPage />} />
              <Route path="/remove-metadata" element={<RemoveMetadataPage />} />
              <Route path="/edit-metadata" element={<EditMetadataPage />} />
              <Route path="/unlock" element={<UnlockPdfPage />} />
              <Route path="/page-numbers" element={<PageNumbersPage />} />
              <Route path="/header-footer" element={<HeaderFooterPage />} />
              <Route path="/bates" element={<BatesPage />} />
              <Route path="/sign" element={<SignPdfPage />} />
              <Route path="/crop" element={<CropPdfPage />} />
              <Route path="/resize" element={<ResizePdfPage />} />
              <Route path="/n-up" element={<NupPdfPage />} />
              <Route path="/images-to-pdf" element={<ImagesToPdfPage />} />
              <Route path="/jpg-to-pdf" element={<Navigate to="/images-to-pdf" replace />} />
              <Route path="/extract-images" element={<ExtractImagesPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </main>
        <Footer />
      </div>
      <Analytics />
    </BrowserRouter>
  );
}
