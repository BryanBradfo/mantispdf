import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { act, type ReactNode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import {
  LocaleProvider,
  Link,
  Navigate,
  loadLocale,
  localeFromPath,
  renderRich,
  useLocale,
  useLocaleNavigate,
  useT,
} from ".";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

async function render(path: string, ui: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={<p>loading</p>}>
          <LocaleProvider>{ui}</LocaleProvider>
        </Suspense>
      </MemoryRouter>,
    );
  });
  // A /fr render suspends on the French chunk; let it resolve and React retry.
  await act(async () => {
    await loadLocale(localeFromPath(path));
  });
  return host;
}

function Probe() {
  const locale = useLocale();
  const t = useT("common");
  return (
    <p data-testid="probe">
      {locale}|{t("errorWrongPassword")}
    </p>
  );
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

describe("LocaleProvider + useT", () => {
  it("serves English at the root", async () => {
    const el = await render("/merge", <Probe />);
    expect(el.textContent).toBe("en|Wrong password");
  });

  it("lazy-loads French under /fr", async () => {
    const el = await render("/fr/merge", <Probe />);
    expect(el.textContent).toBe("fr|Mot de passe incorrect");
  });
});

describe("preloading", () => {
  it("renders French without suspending once the chunk is loaded", async () => {
    // Fresh module instance: React has never seen this load promise.
    vi.resetModules();
    const fresh = await import(".");
    await fresh.loadLocale("fr");
    function FreshProbe() {
      return <p>{fresh.useT("common")("errorWrongPassword")}</p>;
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    // One synchronous commit: no fallback when the dictionary is already there.
    act(() => {
      root!.render(
        <MemoryRouter initialEntries={["/fr"]}>
          <Suspense fallback={<p>loading</p>}>
            <fresh.LocaleProvider>
              <FreshProbe />
            </fresh.LocaleProvider>
          </Suspense>
        </MemoryRouter>,
      );
    });
    expect(host.textContent).toBe("Mot de passe incorrect");
  });
});

describe("Link", () => {
  it("keeps the current locale prefix", async () => {
    const el = await render(
      "/fr/merge",
      <>
        <Link to="/split">a</Link>
        <Link to="/">b</Link>
        <Link to={{ pathname: "/ocr", search: "?x=1" }}>c</Link>
      </>,
    );
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/fr/split", "/fr", "/fr/ocr?x=1"]);
  });

  it("leaves English links unprefixed", async () => {
    const el = await render("/merge", <Link to="/split">a</Link>);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("/split");
  });
});

describe("Navigate and useLocaleNavigate", () => {
  it("redirects within the current locale", async () => {
    const el = await render(
      "/fr/edit",
      <Routes>
        <Route path="/fr/edit" element={<Navigate to="/organize" replace />} />
        <Route path="*" element={<Where />} />
      </Routes>,
    );
    expect(el.textContent).toBe("/fr/organize");
  });

  it("navigates within the current locale", async () => {
    function Go() {
      const navigate = useLocaleNavigate();
      return <button onClick={() => navigate("/split")}>go</button>;
    }
    const el = await render(
      "/fr",
      <>
        <Go />
        <Where />
      </>,
    );
    await act(async () => el.querySelector("button")!.click());
    expect(el.querySelector("[data-testid=where]")?.textContent).toBe("/fr/split");
  });
});

describe("renderRich", () => {
  it("wraps tagged chunks with the given components", async () => {
    const el = await render(
      "/",
      <p>{renderRich("Read <link>the guide</link> first.", { link: (c) => <a href="/g">{c}</a> })}</p>,
    );
    expect(el.innerHTML).toContain('Read <a href="/g">the guide</a> first.');
  });

  it("leaves a tag without a component as plain text", async () => {
    const el = await render("/", <p>{renderRich("A <b>bold</b> move", {})}</p>);
    expect(el.textContent).toBe("A bold move");
  });
});
