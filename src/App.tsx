import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";
import HomePage from "./pages/HomePage";
import SplitPdfPage from "./pages/SplitPdfPage";
import MergePdfPage from "./pages/MergePdfPage";
import CompressPdfPage from "./pages/CompressPdfPage";
import RotatePdfPage from "./pages/RotatePdfPage";
import EditPdfPage from "./pages/EditPdfPage";
import PdfToImagePage from "./pages/PdfToImagePage";

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/split" element={<SplitPdfPage />} />
            <Route path="/merge" element={<MergePdfPage />} />
            <Route path="/compress" element={<CompressPdfPage />} />
            <Route path="/rotate" element={<RotatePdfPage />} />
            <Route path="/edit" element={<EditPdfPage />} />
            <Route path="/pdf-to-image" element={<PdfToImagePage />} />
          </Routes>
        </main>
        <Footer />
      </div>
      <Analytics />
    </BrowserRouter>
  );
}
