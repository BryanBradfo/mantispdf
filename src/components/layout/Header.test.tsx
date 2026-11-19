import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { LocaleProvider } from "../../i18n";
import Header from "./Header";
import ToolShell from "../../pages/ToolShell";

let root: Root;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ stargazers_count: 1234 }) })));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

async function renderAt(path: string, children = <Header />) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={null}>
          <LocaleProvider>
            {children}
            <Where />
          </LocaleProvider>
        </Suspense>
      </MemoryRouter>,
    );
  });
}

const toolsButton = () => host.querySelector<HTMLButtonElement>("header button[aria-expanded]")!;
const menu = () => host.querySelector('nav[aria-label="All tools"]');
const where = () => host.querySelector('[data-testid="where"]')?.textContent;

describe("Header TOOLS menu", () => {
  it("opens a menu with the five sections and the 27 tools", async () => {
    await renderAt("/merge");
    expect(menu()).toBeNull();
    await act(async () => toolsButton().click());
    expect(toolsButton().getAttribute("aria-expanded")).toBe("true");
    expect(menu()?.querySelectorAll("h2")).toHaveLength(5);
    expect(menu()?.querySelectorAll("a")).toHaveLength(27);
  });

  it("closes on Escape and gives focus back to the button", async () => {
    await renderAt("/merge");
    await act(async () => toolsButton().click());
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(toolsButton());
  });

  it("navigates and closes when a tool is chosen", async () => {
    await renderAt("/merge");
    await act(async () => toolsButton().click());
    const split = [...menu()!.querySelectorAll("a")].find((a) => a.textContent === "Split PDF")!;
    await act(async () => split.click());
    expect(where()).toBe("/split");
    expect(menu()).toBeNull();
  });

  it("asks GitHub for the star count on the home page only", async () => {
    await renderAt("/merge");
    expect(fetch).not.toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
    await renderAt("/");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("1.2k+");
  });
});

describe("ToolShell eyebrow", () => {
  it("shows the tool's section number and name above the title", async () => {
    await renderAt(
      "/merge",
      <ToolShell tool="merge" title="t" description="d" path="/merge" heading="Merge PDF" intro="i">
        {null}
      </ToolShell>,
    );
    const eyebrow = host.querySelector('[data-testid="tool-eyebrow"]');
    expect(eyebrow?.textContent).toBe("01 / Organize");
    expect(eyebrow?.querySelector("svg")).not.toBeNull();
    expect(eyebrow?.compareDocumentPosition(host.querySelector("h1")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("has no eyebrow when the page does not name its tool", async () => {
    await renderAt(
      "/x",
      <ToolShell title="t" description="d" path="/x" heading="X" intro="i">
        {null}
      </ToolShell>,
    );
    expect(host.querySelector('[data-testid="tool-eyebrow"]')).toBeNull();
  });
});
