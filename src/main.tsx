import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pdfjs } from "react-pdf";
import { HelmetProvider } from "react-helmet-async";
// Import the pdf.js worker as a URL so Vite bundles it and resolves it correctly
// in BOTH dev and production. The previous `new URL("pdfjs-dist/...", import.meta.url)`
// form was not reliably resolved for a bare node_modules specifier in production
// builds, so the worker 404'd and react-pdf's <Document> hung on "Loading PDF…".
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import App from "./App";
import "./index.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </StrictMode>,
);
