import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App";
import { startFirstLoad } from "./firstLoad";
import { dropPrerenderedHead } from "./seo/prerenderedHead";
import { startPwa } from "./pwa/start";
// UI fonts, self-hosted (no request leaves the app origin). Every subset is
// declared with its unicode-range, so a page in Latin script downloads only
// the latin files.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/oswald/wght.css";
import "./index.css";
// The pdf.js worker is configured in src/lib/pdf.ts (the single module every
// react-pdf consumer imports through), so it lands on the same pdfjs instance
// the components use — code-splitting otherwise gives lazy routes a separate
// instance, which is why configuring it here previously had no effect.

// Prerendered head tags give way to PageSEO's (the title stays until the app sets its own).
dropPrerenderedHead(document);

// A /fr first load fetches the French dictionary and the page's chunk in parallel.
startFirstLoad(window.location.pathname);

// The installable web app: install prompt capture and service worker (never in the desktop app).
startPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </StrictMode>,
);
