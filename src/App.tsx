import { BrowserRouter, Routes, Route } from "react-router-dom";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";
import HomePage from "./pages/HomePage";
import SplitPdfPage from "./pages/SplitPdfPage";
import MergePdfPage from "./pages/MergePdfPage";
import CompressPdfPage from "./pages/CompressPdfPage";

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
          </Routes>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
