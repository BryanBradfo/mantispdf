import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider, loadLocale } from "../../i18n";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";

const tauri = vi.hoisted(() => ({ on: false }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri.on }));

import InstallCard from "./InstallCard";
import { __resetInstallForTests, startInstallCapture } from "../../pwa/install";

const UA = {
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
};

let host: HTMLDivElement;
let root: Root;
let win: EventTarget;

function capture(userAgent: string, displayMode: string | null = null) {
  win = new EventTarget();
  startInstallCapture({
    navigator: { userAgent, maxTouchPoints: userAgent === UA.iphone ? 5 : 0 },
    matchMedia: (q) => ({ matches: displayMode !== null && q === `(display-mode: ${displayMode})` }),
    addEventListener: (type, l) => win.addEventListener(type, l),
  });
}

function offerPrompt(outcome: "accepted" | "dismissed" = "accepted") {
  const e = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn(() => Promise.resolve());
  Object.assign(e, { prompt, userChoice: Promise.resolve({ outcome }) });
  act(() => void win.dispatchEvent(e));
  return prompt;
}

async function render(locale: "en" | "fr" = "en") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[locale === "fr" ? "/fr" : "/"]}>
        <Suspense fallback={null}>
          <LocaleProvider>
            <InstallCard />
          </LocaleProvider>
        </Suspense>
      </MemoryRouter>,
    );
  });
}

const card = () => host.querySelector<HTMLElement>('[data-testid="install-card"]');
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await loadLocale("fr");
});

beforeEach(() => {
  __resetInstallForTests();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  tauri.on = false;
  act(() => root.unmount());
  host.remove();
});

describe("InstallCard", () => {
  it("Chromium with a prompt: the Install app button opens the browser's dialog, then says it is installed", async () => {
    capture(UA.chrome);
    await render();
    const prompt = offerPrompt("accepted");
    expect(card()!.textContent).toContain("Install in your browser");
    expect(card()!.textContent).toContain("No download, no warning, works offline.");
    await act(async () => button("Install app")!.click());
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(card()!.textContent).toContain("Installed. Open MantisPDF from your apps.");
    expect(button("Install app")).toBeUndefined();
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
    expect(host.textContent).not.toMatch(/[·—]/);
  });

  it("Chromium without a prompt points to the browser's menu", async () => {
    capture(UA.chrome);
    await render();
    expect(button("Install app")).toBeUndefined();
    expect(card()!.textContent).toContain("address bar or menu");
  });

  it("iOS: Share, then Add to Home Screen, in French too", async () => {
    capture(UA.iphone);
    await render("fr");
    expect(card()!.textContent).toContain("Installer dans votre navigateur");
    expect(card()!.textContent).toContain("touchez Partager, puis Sur l’écran d’accueil");
  });

  it("Firefox desktop: the desktop app is the option", async () => {
    capture(UA.firefox);
    await render();
    expect(card()!.textContent).toContain("Firefox cannot install web apps");
  });

  it("hidden in the installed app (display-mode standalone)", async () => {
    capture(UA.chrome, "standalone");
    await render();
    expect(card()).toBeNull();
  });

  it("never shown in the Tauri desktop app", async () => {
    tauri.on = true;
    capture(UA.chrome);
    await render();
    offerPrompt();
    expect(card()).toBeNull();
  });
});
