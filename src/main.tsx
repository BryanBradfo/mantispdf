import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pdfjs } from "react-pdf";
import { HelmetProvider } from "react-helmet-async";
import App from "./App";
import "./index.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </StrictMode>,
);
