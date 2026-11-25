import { lazy, Suspense } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import TitleBar from "./components/desktop/TitleBar";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";
import FrenchBanner from "./components/layout/FrenchBanner";
import { HtmlLang } from "./components/seo/PageSEO";
import { LocaleProvider, localizeRoutes } from "./i18n";
import ErrorBoundary from "./components/common/ErrorBoundary";
import { APP_ROUTES } from "./routes";
import PwaUpdatePanel from "./components/pwa/PwaUpdatePanel";

const ROUTES = localizeRoutes(APP_ROUTES);

// Desktop only, and loaded lazily: the web bundle never carries the updater plugins.
const DesktopUpdateBanner = lazy(() => import("./components/desktop/DesktopUpdateBanner"));
const DesktopSettingsDialog = lazy(() => import("./components/desktop/DesktopSettingsDialog"));

/** The settings dialog and update panel of the Tauri shell; a failure there (even a chunk that will not load) shows nothing. */
function DesktopExtras() {
  if (!isTauri()) return null;
  return (
    <>
      <ErrorBoundary silent>
        <Suspense fallback={null}>
          <DesktopUpdateBanner />
        </Suspense>
      </ErrorBoundary>
      <ErrorBoundary silent>
        <Suspense fallback={null}>
          <DesktopSettingsDialog />
        </Suspense>
      </ErrorBoundary>
    </>
  );
}

function PageSpinner() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-3 border-t-transparent" />
    </div>
  );
}

/** The routed page; an error in it shows a notice and clears on the next navigation. */
function Pages() {
  return (
    // A stale chunk (old tab after a deploy) defers to the update panel, which App keeps mounted outside.
    <ErrorBoundary resetKey={useLocation().pathname} staleChunkAsUpdate>
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
            <DesktopExtras />
            {/* The web app's "new version" panel; the desktop app has its own updater. */}
            {!isTauri() && <PwaUpdatePanel />}
          </LocaleProvider>
        </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
