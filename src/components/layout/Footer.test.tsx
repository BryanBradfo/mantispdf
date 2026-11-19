import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider, loadLocale, localeFromPath } from "../../i18n";
import { TOOLS } from "../../lib/tools";
import Footer from "./Footer";

let root: Root;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function renderAt(path: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={null}>
          <LocaleProvider>
            <Footer />
          </LocaleProvider>
        </Suspense>
      </MemoryRouter>,
    );
  });
  // A /fr render suspends on the French chunk; let it resolve and React retry.
  await act(async () => {
    await loadLocale(localeFromPath(path)).catch(() => {});
  });
}

const footer = () => host.querySelector("footer")!;
const hrefs = (sel: string) => [...footer().querySelectorAll<HTMLAnchorElement>(sel)].map((a) => a.getAttribute("href"));
const REPO = "https://github.com/BryanBradfo/mantispdf";

describe("Footer", () => {
  it("links every tool, section by section, from the tool table", async () => {
    await renderAt("/");
    expect(hrefs('section a[href^="/"]')).toEqual(TOOLS.map((t) => t.href));
    expect(footer().querySelectorAll("h2")).toHaveLength(6);
    expect(footer().textContent).toContain("Merge PDF");
    expect(footer().textContent).toContain("Recognize");
  });

  it("localizes the tool links under /fr", async () => {
    await renderAt("/fr");
    expect(hrefs('section a[href^="/"]')).toEqual(TOOLS.map((t) => `/fr${t.href}`));
    expect(footer().textContent).toContain("Fusionner PDF");
    expect(footer().textContent).toContain("100 % dans votre navigateur");
  });

  it("links the project on GitHub in a new tab, without an opener", async () => {
    await renderAt("/");
    const external = [...footer().querySelectorAll<HTMLAnchorElement>('a[href^="https://"]')];
    expect(external.map((a) => a.getAttribute("href"))).toEqual([
      REPO,
      `${REPO}/issues`,
      `${REPO}/blob/main/CONTRIBUTING.md`,
      `${REPO}/blob/main/LICENSE`,
      REPO,
    ]);
    for (const a of external) {
      expect(a.target).toBe("_blank");
      expect(a.rel.split(" ")).toContain("noopener");
    }
    // The icon-only GitHub link still has a name.
    expect(external[external.length - 1].getAttribute("aria-label")).toBe("MantisPDF on GitHub");
  });

  it("shows the giant wordmark to the eye only, and the current year", async () => {
    await renderAt("/");
    const mark = footer().querySelector('[data-testid="footer-wordmark"]');
    expect(mark?.textContent).toBe("MantisPDF");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(footer().textContent).toContain(`© ${new Date().getFullYear()} MantisPDF`);
    expect(footer().textContent).toContain("All processing happens in your browser. No data is uploaded.");
  });
});
