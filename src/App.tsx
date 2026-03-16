import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";

const HomePage = lazy(() => import("./pages/HomePage"));
const SplitPdfPage = lazy(() => import("./pages/SplitPdfPage"));
const MergePdfPage = lazy(() => import("./pages/MergePdfPage"));
const CompressPdfPage = lazy(() => import("./pages/CompressPdfPage"));
const RotatePdfPage = lazy(() => import("./pages/RotatePdfPage"));
const EditPdfPage = lazy(() => import("./pages/EditPdfPage"));
const PdfToImagePage = lazy(() => import("./pages/PdfToImagePage"));
const WatermarkPdfPage = lazy(() => import("./pages/WatermarkPdfPage"));
const EncryptPdfPage = lazy(() => import("./pages/EncryptPdfPage"));

function PageSpinner() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="flex-1">
          <Suspense fallback={<PageSpinner />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/split" element={<SplitPdfPage />} />
              <Route path="/merge" element={<MergePdfPage />} />
              <Route path="/compress" element={<CompressPdfPage />} />
              <Route path="/rotate" element={<RotatePdfPage />} />
              <Route path="/edit" element={<EditPdfPage />} />
              <Route path="/pdf-to-image" element={<PdfToImagePage />} />
              <Route path="/watermark" element={<WatermarkPdfPage />} />
              <Route path="/encrypt" element={<EncryptPdfPage />} />
            </Routes>
          </Suspense>
        </main>
        <Footer />
      </div>
      <Analytics />
    </BrowserRouter>
  );
}
