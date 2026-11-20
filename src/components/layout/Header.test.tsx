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
  vi.stubGlobal("fetch", vi.fn());
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
  it("opens a menu with the five sections and the 28 tools", async () => {
    await renderAt("/merge");
    expect(menu()).toBeNull();
    await act(async () => toolsButton().click());
    expect(toolsButton().getAttribute("aria-expanded")).toBe("true");
    expect(menu()?.querySelectorAll("h2")).toHaveLength(5);
    expect(menu()?.querySelectorAll("a")).toHaveLength(28);
  });

  it("moves focus to the first tool when opened", async () => {
    await renderAt("/merge");
    await act(async () => toolsButton().click());
    expect(document.activeElement?.textContent).toBe("Merge PDF");
    expect(menu()?.contains(document.activeElement)).toBe(true);
  });

  it("closes when focus leaves the header and its panel, not when it moves inside", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    await renderAt("/merge");
    await act(async () => toolsButton().click());
    const links = menu()!.querySelectorAll("a");
    await act(async () => links[5].focus());
    expect(menu()).not.toBeNull();
    await act(async () => outside.focus());
    expect(menu()).toBeNull();
    outside.remove();
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

  it("makes no network request, not even for a GitHub star count", async () => {
    await renderAt("/");
    expect(fetch).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("★");
  });
});

describe("Header DOWNLOAD button", () => {
  const downloads = () => [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="header-download"]')];

  it("is a boxed link to the download page on the web, in the current locale", async () => {
    await renderAt("/merge");
    expect(downloads()).toHaveLength(1);
    expect(downloads()[0].getAttribute("href")).toBe("/download");
    expect(downloads()[0].textContent).toBe("Download");
    expect(downloads()[0].className).toMatch(/\bborder\b/);
    await act(async () => downloads()[0].click());
    expect(where()).toBe("/download");
  });

  it("also sits in the menu panel for phones and tablets", async () => {
    await renderAt("/merge");
    await act(async () => toolsButton().click());
    expect(downloads()).toHaveLength(2);
    expect(downloads()[1].closest(".lg\\:hidden")).not.toBeNull();
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

  it("requires every page to name its tool (checked by tsc)", () => {
    // @ts-expect-error `tool` is required: a tool page without its eyebrow does not compile.
    const page = <ToolShell title="t" description="d" path="/x" heading="X" intro="i">{null}</ToolShell>;
    expect(page.props.tool).toBeUndefined();
  });
});
