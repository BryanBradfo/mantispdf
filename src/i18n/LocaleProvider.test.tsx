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

/**
 * A fresh copy of the i18n module (empty load caches) together with its own React, renderer and
 * router: after `vi.resetModules()` they must all come from the same module graph, or hooks run
 * against a different React than the renderer. `setup` installs mocks before anything is imported.
 */
async function freshEnv(setup?: () => void) {
  vi.resetModules();
  setup?.();
  const [react, client, router, i18n] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("react-router-dom"),
    import("."),
  ]);
  const el = document.createElement("div");
  document.body.append(el);
  const freshRoot = client.createRoot(el);
  const render = (path: string, ui: ReactNode) =>
    react.act(() => {
      freshRoot.render(
        <router.MemoryRouter initialEntries={[path]}>
          <react.Suspense fallback={<p>loading</p>}>
            <i18n.LocaleProvider>{ui}</i18n.LocaleProvider>
          </react.Suspense>
        </router.MemoryRouter>,
      );
    });
  const cleanup = () => {
    react.act(() => freshRoot.unmount());
    el.remove();
  };
  return { act: react.act, i18n, el, render, cleanup };
}

describe("preloading", () => {
  it("renders French without suspending once the chunk is loaded", async () => {
    const env = await freshEnv();
    await env.i18n.loadLocale("fr");
    function FreshProbe() {
      return <p>{env.i18n.useT("common")("errorWrongPassword")}</p>;
    }
    // One synchronous commit: no fallback when the dictionary is already there.
    env.render("/fr", <FreshProbe />);
    expect(env.el.textContent).toBe("Mot de passe incorrect");
    env.cleanup();
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
    let calls = 0;
    const env = await freshEnv(() =>
      vi.doMock("./locales/fr/fr", () => {
        calls += 1;
        throw new Error("chunk failed");
      }),
    );
    function FreshProbe() {
      return <p>{env.i18n.useT("common")("errorWrongPassword")}</p>;
    }
    await env.act(async () => {
      env.render("/fr/merge", <FreshProbe />);
    });
    await env.act(async () => {
      await env.i18n.loadLocale("fr").catch(() => {});
    });
    expect(env.el.textContent).toContain("Wrong password");
    expect(env.el.querySelector("[role=status]")?.textContent).toContain("could not be loaded");

    // The failed promise is not cached: retrying calls the loader again.
    const before = calls;
    await env.act(async () => env.el.querySelector<HTMLButtonElement>("[role=status] button")!.click());
    await env.act(async () => {
      await env.i18n.loadLocale("fr").catch(() => {});
    });
    expect(calls).toBeGreaterThan(before);
    env.cleanup();
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
    const env = await freshEnv(() => vi.doMock("@tauri-apps/api/core", () => ({ isTauri: () => true })));
    env.i18n.storeLocale("fr");
    function FreshProbe() {
      return (
        <p>
          {env.i18n.useLocale()}|{env.i18n.useT("common")("errorWrongPassword")}
        </p>
      );
    }
    await env.act(async () => {
      env.render("/merge", <FreshProbe />);
    });
    await env.act(async () => {
      await env.i18n.loadLocale("fr");
    });
    expect(env.el.textContent).toBe("fr|Mot de passe incorrect");
    env.cleanup();
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
