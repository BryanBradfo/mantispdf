import { describe, it, expect, beforeAll, vi } from "vitest";
import { act, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider, loadLocale } from "../../i18n";
import LicenseDialog from "./LicenseDialog";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await loadLocale("fr");
});

describe("LicenseDialog errors", () => {
  it("are described in the UI language", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/fr"]}>
          <Suspense fallback={null}>
            <LocaleProvider>
              <LicenseDialog
                open
                onClose={() => {}}
                status={{ tier: "free" } as never}
                onActivate={() => Promise.reject("this license key is not valid for MantisPDF Pro")}
                onDeactivate={() => Promise.resolve()}
                checkoutUrl="https://example.test"
              />
            </LocaleProvider>
          </Suspense>
        </MemoryRouter>,
      );
    });
    const input = host.querySelector("input")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "KEY");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Activer la licence")!.click();
    });
    expect(host.textContent).toContain("Cette clé de licence n’est pas valable pour MantisPDF Pro.");
    act(() => root.unmount());
    host.remove();
  });

  it("is a square panel on the tokens, without glows, and a rejected key marks the input invalid", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/fr"]}>
          <Suspense fallback={null}>
            <LocaleProvider>
              <LicenseDialog
                open
                onClose={() => {}}
                status={{ tier: "free" } as never}
                onActivate={() => Promise.reject("this license key is not valid for MantisPDF Pro")}
                onDeactivate={() => Promise.resolve()}
                checkoutUrl="https://example.test"
              />
            </LocaleProvider>
          </Suspense>
        </MemoryRouter>,
      );
    });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.className).toMatch(/\brounded-none\b/);
    expect(dialog.className).toMatch(/\bbg-paper\b/);
    expect(host.innerHTML).not.toMatch(/shadow-glow|rounded-(lg|xl|2xl)/);
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
    for (const b of host.querySelectorAll("button, a, input")) expect(b.className).toContain("focus-visible:ring-2");

    const input = host.querySelector("input")!;
    expect(input.getAttribute("aria-invalid")).toBe("false");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "KEY");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Activer la licence")!.click();
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.className).toMatch(/!border-danger/);
    const message = host.querySelector(".text-danger")!;
    expect(message.textContent).toBe("Cette clé de licence n’est pas valable pour MantisPDF Pro.");
    expect(input.getAttribute("aria-describedby")).toBe(message.id);
    act(() => root.unmount());
    host.remove();
  });

  it("behaves as a modal: focus on the key input, Tab wraps inside, Escape closes and focus returns to the opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-opener="" onClick={() => setOpen(true)}>open</button>
          <LicenseDialog
            open={open}
            onClose={() => setOpen(false)}
            status={{ tier: "free" } as never}
            onActivate={() => Promise.resolve({ tier: "pro" } as never)}
            onDeactivate={() => Promise.resolve()}
            checkoutUrl="https://example.test"
          />
        </>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <Suspense fallback={null}>
            <LocaleProvider>
              <Harness />
            </LocaleProvider>
          </Suspense>
        </MemoryRouter>,
      );
    });
    const opener = host.querySelector<HTMLButtonElement>("[data-opener]")!;
    opener.focus();
    await act(async () => opener.click());
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog.querySelector("input"));

    const focusables = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled])")];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const tab = (shiftKey: boolean) =>
      act(() => {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
      });
    last.focus();
    await tab(false);
    expect(document.activeElement).toBe(first);
    await tab(true);
    expect(document.activeElement).toBe(last);

    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(host.querySelector('[role="dialog"]')).toBeNull());
    expect(document.activeElement).toBe(opener);
    act(() => root.unmount());
    host.remove();
  });
});
