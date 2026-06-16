import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App";
import "./index.css";
// The pdf.js worker is configured in src/lib/pdf.ts (the single module every
// react-pdf consumer imports through), so it lands on the same pdfjs instance
// the components use — code-splitting otherwise gives lazy routes a separate
// instance, which is why configuring it here previously had no effect.

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </StrictMode>,
);
