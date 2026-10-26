import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { LocaleProvider, loadLocale } from "../../i18n";
import FrenchBanner from "./FrenchBanner";
import LanguageSwitcher from "./LanguageSwitcher";

let root: Root;
let host: HTMLDivElement;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "languages", { value: ["fr-FR", "fr"], configurable: true });
  await loadLocale("fr");
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

async function renderAt(path: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={null}>
          <LocaleProvider>
            <FrenchBanner />
            <LanguageSwitcher />
            <Where />
          </LocaleProvider>
        </Suspense>
      </MemoryRouter>,
    );
  });
}

const banner = () => host.querySelector('[role="region"]');
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());

describe("FrenchBanner", () => {
  it("shows on an English page for a French browser with no choice", async () => {
    await renderAt("/merge");
    expect(banner()?.textContent).toContain("Version française disponible.");
  });

  it("stays hidden after following it to French and switching back to English", async () => {
    await renderAt("/merge");
    await click(banner()?.querySelector("a"));
    expect(host.querySelector('[data-testid="where"]')?.textContent).toBe("/fr/merge");
    expect(banner()).toBeNull();

    await click(host.querySelector('a[hreflang="en"]'));
    expect(host.querySelector('[data-testid="where"]')?.textContent).toBe("/merge");
    expect(banner()).toBeNull();
  });

  it("hides at once when dismissed, and stays hidden", async () => {
    await renderAt("/");
    await click(banner()?.querySelector("button"));
    expect(banner()).toBeNull();
    expect(localStorage.getItem("locale")).toBe("en");
  });
});
