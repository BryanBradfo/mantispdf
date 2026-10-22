import { Suspense } from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import TitleBar from "./components/desktop/TitleBar";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";
import FrenchBanner from "./components/layout/FrenchBanner";
import { HtmlLang } from "./components/seo/PageSEO";
import { LocaleProvider, localizeRoutes } from "./i18n";
import ErrorBoundary from "./components/common/ErrorBoundary";
import { APP_ROUTES } from "./routes";

const ROUTES = localizeRoutes(APP_ROUTES);

function PageSpinner() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
    </div>
  );
}

/** The routed page; an error in it shows a notice and clears on the next navigation. */
function Pages() {
  return (
    <ErrorBoundary resetKey={useLocation().pathname}>
      <Suspense fallback={<PageSpinner />}>
        <Routes>
          {ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      {/* Last resort: a crash anywhere (even in the locale layer) shows a notice, never a blank app. */}
      <ErrorBoundary>
        {/* LocaleProvider suspends while a non-English dictionary chunk loads. */}
        <Suspense fallback={<PageSpinner />}>
          <LocaleProvider>
            <HtmlLang />
            <div className="flex min-h-screen flex-col">
              <TitleBar />
              <FrenchBanner />
              <Header />
              <main className="flex-1">
                <Pages />
              </main>
              <Footer />
            </div>
          </LocaleProvider>
        </Suspense>
      </ErrorBoundary>
      <Analytics />
    </BrowserRouter>
  );
}
