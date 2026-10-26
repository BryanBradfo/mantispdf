import { describe, it, expect, beforeAll } from "vitest";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider, loadLocale } from "../../i18n";
import LicenseDialog from "./LicenseDialog";

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
});
