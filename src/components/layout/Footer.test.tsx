import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider, loadLocale, localeFromPath } from "../../i18n";
import { TOOLS } from "../../lib/tools";
import Footer from "./Footer";
import { __resetInstallForTests, startInstallCapture } from "../../pwa/install";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
    expect(hrefs('section a[href^="/"]')).toEqual([...TOOLS.map((t) => t.href), "/download"]);
    expect(footer().querySelectorAll("h2")).toHaveLength(6);
    expect(footer().textContent).toContain("Merge PDF");
    expect(footer().textContent).toContain("Analyze");
  });

  it("localizes the tool links under /fr", async () => {
    await renderAt("/fr");
    expect(hrefs('section a[href^="/"]')).toEqual([...TOOLS.map((t) => `/fr${t.href}`), "/fr/download"]);
    expect(footer().textContent).toContain("Fusionner PDF");
    expect(footer().textContent).toContain("100 % dans votre navigateur");
  });

  it("links the desktop app page first in the Project column", async () => {
    await renderAt("/");
    const project = footer().querySelector('section[aria-labelledby="footer-project"]')!;
    const first = project.querySelector("a")!;
    expect(first.getAttribute("href")).toBe("/download");
    expect(first.textContent).toBe("Desktop app");
    expect(first.target).toBe("");
  });

  it("offers Install app in the Project column only while the browser's install prompt is ready", async () => {
    __resetInstallForTests();
    const win = new EventTarget();
    startInstallCapture({ navigator: { userAgent: "Chrome/142" }, addEventListener: (t, l) => win.addEventListener(t, l) });
    await renderAt("/");
    const install = () => [...footer().querySelectorAll("button")].find((b) => b.textContent === "Install app");
    expect(install()).toBeUndefined();
    const e = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(e, { prompt: () => Promise.resolve(), userChoice: Promise.resolve({ outcome: "dismissed" }) });
    act(() => void win.dispatchEvent(e));
    expect(install()!.closest("#footer-project, section")).not.toBeNull();
    await act(async () => install()!.click());
    expect(install()).toBeUndefined();
    __resetInstallForTests();
  });

  it("links the project on GitHub in a new tab, without an opener", async () => {
    await renderAt("/");
    const external = [...footer().querySelectorAll<HTMLAnchorElement>('a[href^="https://"]')];
    expect(external.map((a) => a.getAttribute("href"))).toEqual([
      REPO,
      `${REPO}/issues`,
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

  it("draws the dithered mantis banner, decorative, as a mask over the wordmark", async () => {
    await renderAt("/");
    const banner = footer().querySelector<HTMLElement>('[data-testid="footer-mantis"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("aria-hidden")).toBe("true");
    expect(banner!.className).toContain("bg-ink/");
    expect(banner!.style.getPropertyValue("mask-image")).toContain('url("/brand/footer-mantis.png")');
    expect(banner!.style.getPropertyValue("-webkit-mask-image")).toContain('url("/brand/footer-mantis.png")');
    // It sits directly above the wordmark.
    expect(banner!.nextElementSibling?.getAttribute("data-testid")).toBe("footer-wordmark");
  });

  it("puts each section in its own column, under a one-word eyebrow, with the slogan in the brand block", async () => {
    await renderAt("/");
    const headings = [...footer().querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings).toEqual(["Organize", "Optimize and convert", "Edit and sign", "Security and privacy", "Analyze", "Project"]);
    const eyebrows = [...footer().querySelectorAll("nav section")].map((sec) => sec.querySelector("p")?.textContent);
    expect(eyebrows).toEqual(["Pages", "Files", "Content", "Protection", "Text", "Resources"]);
    // Six columns side by side: no column holds two sections any more.
    const nav = footer().querySelector("nav")!;
    expect([...nav.children].filter((c) => c.querySelectorAll("section").length > 1)).toEqual([]);
    expect(footer().textContent).toContain("Every PDF tool. Zero uploads.");
    expect(footer().textContent).not.toContain("100% Private");
    expect(footer().textContent).not.toMatch(/\b0[1-5]\b/);
  });

  it("translates the eyebrows and the slogan under /fr", async () => {
    await renderAt("/fr");
    const eyebrows = [...footer().querySelectorAll("nav section")].map((sec) => sec.querySelector("p")?.textContent);
    expect(eyebrows).toEqual(["Pages", "Fichiers", "Contenu", "Protection", "Texte", "Ressources"]);
    expect(footer().textContent).toContain("Tous les outils PDF. Zéro envoi.");
  });
});

describe("Product wording", () => {
  it("never advertises the product as open source or names its license in the UI", () => {
    const dir = "src/i18n/locales";
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const hits = files.filter((f) => /open[ -]?source|MIT licen[cs]e|licence MIT/i.test(readFileSync(join(dir, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
