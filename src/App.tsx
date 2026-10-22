import { Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import TitleBar from "./components/desktop/TitleBar";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";
import FrenchBanner from "./components/layout/FrenchBanner";
import { HtmlLang } from "./components/seo/PageSEO";
import { LocaleProvider, localizeRoutes } from "./i18n";
import { APP_ROUTES } from "./routes";

const ROUTES = localizeRoutes(APP_ROUTES);

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
      {/* LocaleProvider suspends while a non-English dictionary chunk loads. */}
      <Suspense fallback={<PageSpinner />}>
        <LocaleProvider>
          <HtmlLang />
          <div className="flex min-h-screen flex-col">
            <TitleBar />
            <FrenchBanner />
            <Header />
            <main className="flex-1">
              <Suspense fallback={<PageSpinner />}>
                <Routes>
                  {ROUTES.map((r) => (
                    <Route key={r.path} path={r.path} element={r.element} />
                  ))}
                </Routes>
              </Suspense>
            </main>
            <Footer />
          </div>
        </LocaleProvider>
      </Suspense>
      <Analytics />
    </BrowserRouter>
  );
}
