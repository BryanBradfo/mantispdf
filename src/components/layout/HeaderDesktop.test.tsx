import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider } from "../../i18n";
import Header from "./Header";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

let root: Root;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Header inside the desktop app", () => {
  it("has no DOWNLOAD button, not even in the menu", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/merge"]}>
          <Suspense fallback={null}>
            <LocaleProvider>
              <Header />
            </LocaleProvider>
          </Suspense>
        </MemoryRouter>,
      );
    });
    expect(host.querySelector("header")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>("header button[aria-expanded]")!.click());
    expect(host.querySelector('a[href$="/download"]')).toBeNull();
    expect(host.textContent).not.toContain("Download");
  });
});
