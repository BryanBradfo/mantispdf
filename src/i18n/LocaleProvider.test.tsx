import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { act, type ReactNode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import {
  LocaleProvider,
  Link,
  Navigate,
  Trans,
  loadLocale,
  localeFromPath,
  useLocale,
  useLocaleNavigate,
  useT,
} from ".";
import { renderRich } from "./LocaleProvider";
import * as barrel from ".";
import ErrorBoundary from "../components/common/ErrorBoundary";

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
    await loadLocale(localeFromPath(path)).catch(() => {});
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

describe("Trans", () => {
  it("renders a message with tags through its components", async () => {
    const el = await render(
      "/",
      <Trans ns="common" k="dropPdf" components={{ browse: (c) => <b>{c}</b> }} />,
    );
    expect(el.innerHTML).toBe("Drop your PDF here or <b>browse</b>");
  });

  it("needs no components for a message without tags", async () => {
    const el = await render("/", <Trans ns="common" k="errorWrongPassword" />);
    expect(el.textContent).toBe("Wrong password");
  });

  it("type-checks components", () => {
    // @ts-expect-error `browse` needs a component
    void (<Trans ns="common" k="dropPdf" />);
    expect(true).toBe(true);
  });

  it("is the only rich-text API the barrel exports", () => {
    expect("renderRich" in barrel).toBe(false);
  });
});

describe("a French chunk that fails to load", () => {
  it("falls back to English with a notice, and a retry loads it again", async () => {
    vi.resetModules();
    let calls = 0;
    vi.doMock("./locales/fr/fr", () => {
      calls += 1;
      throw new Error("chunk failed");
    });
    const fresh = await import(".");
    function FreshProbe() {
      return <p>{fresh.useT("common")("errorWrongPassword")}</p>;
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={["/fr/merge"]}>
          <Suspense fallback={<p>loading</p>}>
            <fresh.LocaleProvider>
              <FreshProbe />
            </fresh.LocaleProvider>
          </Suspense>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await fresh.loadLocale("fr").catch(() => {});
    });
    expect(host.textContent).toContain("Wrong password");
    expect(host.querySelector("[role=status]")?.textContent).toContain("could not be loaded");

    // The failed promise is not cached: retrying calls the loader again.
    const before = calls;
    await act(async () => host.querySelector<HTMLButtonElement>("[role=status] button")!.click());
    await act(async () => {
      await fresh.loadLocale("fr").catch(() => {});
    });
    expect(calls).toBeGreaterThan(before);
    vi.doUnmock("./locales/fr/fr");
  });
});

describe("ErrorBoundary", () => {
  it("shows a notice instead of a blank app when a child throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): never {
      throw new Error("boom");
    }
    const el = await render(
      "/",
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    spy.mockRestore();
    expect(el.querySelector("[role=alert]")?.textContent).toContain("Something went wrong");
  });
});

describe("desktop app (Tauri)", () => {
  it("shows the stored language on an unprefixed path", async () => {
    vi.resetModules();
    vi.doMock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
    const fresh = await import(".");
    fresh.storeLocale("fr");
    function FreshProbe() {
      return (
        <p>
          {fresh.useLocale()}|{fresh.useT("common")("errorWrongPassword")}
        </p>
      );
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={["/merge"]}>
          <Suspense fallback={<p>loading</p>}>
            <fresh.LocaleProvider>
              <FreshProbe />
            </fresh.LocaleProvider>
          </Suspense>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await fresh.loadLocale("fr");
    });
    expect(host.textContent).toBe("fr|Mot de passe incorrect");
    vi.doUnmock("@tauri-apps/api/core");
    localStorage.clear();
  });

  it("ignores a stored choice in the browser (URLs decide)", async () => {
    localStorage.setItem("locale", "fr");
    const el = await render("/merge", <Probe />);
    expect(el.textContent).toBe("en|Wrong password");
    localStorage.clear();
  });
});
